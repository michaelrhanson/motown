#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



// Module dependencies.
const 
utils             = require('util'),
WebSocketServer   = require('websocket').server,
sio               = require('socket.io'),
uuid              = require('node-uuid'),
createRedisClient = require('../../lib/redis'),
pubsubRedis       = createRedisClient(),
parseCookie       = require('connect').utils.parseCookie,
logger            = require('winston'),
config            = require('../../lib/configuration'),
User              = require('../models/user');
mysql             = require('mysql').createClient(config.get('mysql'));

var
connections = {}, // {'email@domain': [conn, conn], ...}
socket = null,
io = null;


//TODO: Swap email over to be id.

function sendMessageToEachConnectionByEmail(email, message){
  if (email in connections){
    for (var i in connections[email]){
      var conn = connections[email][i];
      conn.sendUTF(message);
    }
  }
}

/*
 * Story Stuff: This should really get rolled up into a model.
 */
function sendStoryToUser(story, user){
  var message = JSON.stringify({
    topic: 'feed.story',
    data: story
  });

  sendMessageToEachConnectionByEmail(user, message);
}

function subscribeForStories(){
  pubsubRedis.on("ready", function(){
    pubsubRedis.subscribe("stories");

    pubsubRedis.on("message", function(channel, message){
      logger.debug("Message received in socket.js.");
      if (channel == "stories"){
        var data = JSON.parse(message);
        
        var users = data.users;
        for (var i in users){
          if (users[i] in connections){
            sendStoryToUser(data.story, users[i]);
          }
        }
      }
      else{
        logger.error("Redis message received in socket.js on unexpected channel: " + channel);
      }
    });
  });
}

// TODO: remove email when connections indexes by id
function sendContactListToUser(userId, email){

  mysql.query(
    "SELECT DISTINCT \
      users.real_name, \
      users.nick, \
      CONCAT('http://www.gravatar.com/avatar/', MD5(users.email)) as gravatar, \
      networks.status \
    FROM \
      users \
    INNER JOIN \
      networks \
      ON \
      networks.user_id = users.id \
    WHERE \
      networks.channel in (SELECT channel FROM networks as n2 WHERE n2.user_id = ?)",
      // AND \
      // networks.user_id <> ?"
    [userId],
    function(err, rows){
      if (err)
        logger.error(err);

      if (rows && rows.length > 0){
        var contacts = [];
        for (var i in rows){
          contacts.push({
            realName: rows[i].real_name,
            gravatar: rows[i].gravatar,
            nick: rows[i].nick,
            status: rows[i].status || 'available'  
          });
        }

        sendMessageToEachConnectionByEmail(email, JSON.stringify({topic: 'contacts.list', data: contacts}));
      }
    }
  );
}

function userConnected(user){
  //TODO: Switch to using ids for stories
  mysql.query("SELECT * FROM stories where user = ? ORDER BY created_at DESC LIMIT 30", [user.email], function(err, rows){
    logger.debug(rows.length + ' stories found for user.');

    //We do this backwards because we want the most recent 30, from sql, but the oldest first
    for(var i = rows.length; i > 0; i--){
      var story = JSON.parse(rows[i-1].data);
      sendStoryToUser(story, user.email);
    }
  });
  
  var responseQueue = "irc-resp:" + uuid.v1();
  var redis = createRedisClient();
  redis.lpush("irc:updateUserStatusFromId", JSON.stringify([user.id, responseQueue]));

  // We block for two minutes max.
  redis.brpop(responseQueue, 120, function(err, data){
    if (!data)
      logger.error("Timeout exceeded waiting for IRC daemon to update user: " + user.id);

    // Even if we get an error, we try to do our magic.
    sendContactListToUser(user.id, user.email);
  });
}

module.exports = {
  listen: function(httpd, store){
    
    socket = new WebSocketServer({
      httpServer: httpd,
      autoAcceptConnections: false
    });

    subscribeForStories();
    
    // This is during the socket upgrade request.
    // We reject for a few reasons mostly around auth
    socket.on('request', function(request){
      if (!request.httpRequest.headers.cookie){
        logger.info('Socket request rejected because it lacked cookie data.');
        return request.reject();
      }

      // here we use parseCookie instead of the already parsed cookies because
      // it puts it in a stupid format:
      // cookies: [ { name: 'express.sid', value: 'cHi8HFKx2C...
      var cookies = parseCookie(request.httpRequest.headers.cookie);

      if (!cookies['express.sid']){
        logger.info('Socket request rejected because it lacked an express.sid (Session)');
        return request.reject();
      }
      var sessionID = cookies['express.sid'];
      store.load(sessionID, function(err, session){
        if (err || !session){
          logger.error('Socket request rejected due to error loading session: ' + err);
          return request.reject();
        }
        else if ( !session.passport || !session.passport.user){
          logger.info('Socket request rejected. -- Passport user empty.');
          return request.reject();
        }
        else{
          var connection = request.accept();

          var user = User.find(session.passport.user, function(err, user){

            connection.user = user.email;
            connection.sessionID = sessionID;

            if (!connections[user.email]){
              connections[user.email] = [];
            }

            connections[user.email].push(connection);

            logger.debug(user.email + " connected");

            userConnected(user);

            connection.on('close', function() {
              logger.debug(connection.user + " disconnected");
              var userConnections = connections[connection.user];
              var previousCount = userConnections.length

              var index = userConnections.indexOf(connection);

              if (~index) {
                // remove the connection from the pool
                userConnections.splice(index, 1);
                if (!userConnections.length){
                  delete connections[connection.user];
                }
              }
            });
          });
        }
      });
    });
  },


  listen_sockio: function(httpd, store){
    io = sio.listen(httpd, {
      'browser client minification': false,
      'browser client etag': false,
      'browser client gzip': false,
      'log level': 'debug',
      'destroy upgrade': false,
      'transports': ['websocket'],
      'authorization': function (handshakeData, accept) {
        // We don't accept non-cookie'd connections
        if (!handshakeData.headers.cookie) {
          return accept('No cookie transmitted.', false);
        }

        handshakeData.cookie = parseCookie(handshakeData.headers.cookie);
        handshakeData.sessionID = handshakeData.cookie['express.sid'];
        

        store.load(handshakeData.sessionID, function (err, session) {
          if (err || !session || !session.passport || !session.passport.user)
            return accept('Error', false);
          
          handshakeData.session = session;
          handshakeData.user = session.passport.user
          return accept(null, true);
        });
      }
    });
    
    io.sockets.on('connection', function(client){
      var user = client.handshake.user;
      // we have the user join a self-named room to support multiple clients
      client.join(user);
      
      // This is just for keeping track of who is here.
      if (!connectedUsers[user]){
        connectedUsers[user] = 0;
      }
      connectedUsers[user] += 1;

      client.on('disconnect', function () {
        connectedUsers[user] -= 1;
        if (connectedUsers[user] <= 0)
          delete(connectedUsers[user]);
      });

      client.log.info(
        client.handshake.user,
        'connected to MoTown'
      );
    });
  },
  storyTime: function(users, story){
    for (var user in users){
      user = users[user];
      if (user in connectedUsers){
        io.broadcast.to(user).emit('sidebar', {topic: 'feed.story', data: story});
      }
    }
    
  }
};
