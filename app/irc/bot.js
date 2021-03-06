#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
 
const
Url = require('url');

var
config      = require('../../lib/configuration'),
logger      = require('../../lib/logger'),
irc         = require('irc'),
util        = require('util'),
Listeners   = require('./bot-listeners'),
Worker      = require('./bot-worker'),
uuid        = require('node-uuid'),
events      = require('events');

require('../../lib/extensions/number');

function Bot(){
  this.state = "booting";

  events.EventEmitter.call(this);

  var ircConfig = config.get('irc');
  logger.info("IRC Bot Starting up.  Server is " + ircConfig.server);

  this.listeners = new Listeners(this);
  this.worker = new Worker(this);
  this.nick = ircConfig.nick;

  this.client = new irc.Client(ircConfig.server, ircConfig.nick, {
    autoConnect: false,
    debug: false,
    retryDelay: ircConfig.retryDelay,
    realName: 'Non-archiving MoTown bot',
    channels: ['#motown']
  });

  this.nicksByBaseNick = {}; // {'wex': 'wex|afk', ...}
  this.aliases = {}; // {'wex|afk': 'wex'}
  
  // Contextualize this for annonymous callbacks
  var self = this;
  
  this.client.addListener('error', this.listeners.error);

  this.client.addListener('close',      this.listeners.connectionClosed);
  this.client.once('registered', this.listeners.botRegistered);

  this.client.addListener('join',       this.listeners.userJoinedMotownChannel);

  this.client.addListener('part',       this.listeners.userLeft); // channel, who, reason
  this.client.addListener('kick',       this.listeners.userLeft); // channel, who, by, reason
  this.client.addListener('kill',       this.listeners.userDisconnected); // who, reason, channels
  this.client.addListener('quit',       this.listeners.userDisconnected); // who, reason, channels

  this.client.addListener('nick',       this.listeners.userNickChanged);
  this.client.addListener('raw',        function(p){logger.silly(p)});

  this.on('operational', function(){this.state = 'operational'});
  this.state = "ready";
}

util.inherits(Bot, events.EventEmitter);


module.exports = Bot;

Bot.prototype.connect = function(callback){
  var self = this;
  
  this.client.connect(10, function(){
    self.state = "connected";
    logger.verbose("IRC Bot connected.");

    if (typeof(callback) == 'function'){
      self.once('operational', function(){
        callback(null, self.state);
      });
    }
  });
};

Bot.prototype.updateUser = function(nick, callback){
  nick = (this.aliases[nick]) ? this.aliases[nick] : nick;
  var self = this;

  if (nick != this.nick){
    this.client.whois(nick, function(response){

      self.listeners.whoisData(response, function(){
        if (typeof(callback) == 'function'){
          callback(response);
        }  
      });
    });
  }
  else{
    if (typeof(callback) == 'function'){
      callback();
    }
  }
};

Bot.prototype.reconnect = function(){
  setTimeout(this.connect, (5).seconds());
  this.state = "reconnecting";
  logger.info("IRC Bot reconnecting in 5 seconds.");
};

Bot.prototype.disconnect = function(cb){
  this.state = 'disconnecting';

  this.client.disconnect(null, function(){
    this.state = 'disconnected';
    if (typeof(cb) == 'function')
      cb();
  });
};

// We run if we weren't 'required'
if (!module.parent){
  console.log("Starting MoTown IRC Bot.");
  var bot = new Bot();
  bot.connect();

  process.on('SIGTERM', function() {
    logger.info('IRC Bot Exiting...');
    bot.disconnect();
  });
}

