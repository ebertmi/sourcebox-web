'use strict';

var util = require('util');
var events = require('events');

var _  = require('lodash');
var debug = require('debug')('sourcebox:process');

var RemoteStream = require('../common/remotestream');
var sbutil = require('../common/util');

var processId = 0;

function Process(socket, command, args, options) {
  Process.super_.call(this);

  debug('exec', command, args, options);

  this.socket = socket;
  this.spawnfile = command;

  this.exitCode = null;
  this.signalCode = null;

  // only send events after this process was attached
  this._eventBuffer = [];

  this.id = processId++;

  this._bind();

  this.socket.emit('exec', this.id, command, args, options);

  if (options.term) {
    this.stdin = new RemoteStream(this.socket, this.id, true);
    this.stdout = this.stderr = this.stdin;
  } else {
    this.stdin = new RemoteStream(this.socket, this.id + '.0', true);
    this.stdout = new RemoteStream(this.socket, this.id + '.1', true);
    this.stderr = new RemoteStream(this.socket, this.id + '.2', true);
  }


  this.stdio = [this.stdin, this.stdout, this.stderr];
  
  if (options.streams && _.isInteger(options.streams)) {
      var fdCounter = 3; // new one after stdio
      var extraStream;
      for (var i = 0; i < options.streams; i++) {
          extraStream = new RemoteStream(this.socket, this.id + '.' + fdCounter, true);
          this.stdio.push(extraStream);
          fdCounter++; // increase
      }
  }

}

util.inherits(Process, events.EventEmitter);

Process.prototype._bind = function () {
  var self = this;

  this._onDisconnect = function () {
    self.signalCode = 'SIGHUP';
    self.emit('error', new Error('Disconnect'));
  };

  this.socket.on(sbutil.processEventId(this.id), this._onEvent.bind(this));
  this.socket.once('disconnect', this._onDisconnect);
};

Process.prototype._unbind = function () {
  this.socket.removeAllListeners(sbutil.processEventId(this.id));
  this.socket.removeListener('disconnect', this._onDisconnect);
};

Process.prototype._onEvent = function (event) {
    var method = this['_' + sbutil.eventToMethod(event)];

    if (method) {
      var args = _.toArray(arguments);
      debug.apply(null, args);

      args.shift();

      method.apply(this, args);
    } else {
      // just re-emit unknown events
      this.emit.apply(this, arguments);
    }
};

Process.prototype._onAttach = function () {
  this._attached = true;

  this.stdio.forEach(function (stream) {
    stream.ready();
  });

  this._eventBuffer.forEach(function (event) {
    this._call.apply(this, event);
  }, this);

  delete this._eventBuffer;
};

Process.prototype._onError = function (error) {
  this._eventBuffer = [];
  this._unbind();

  this.stdio.forEach(function (stream) {
    stream._unbind();
  });

  this.emit('error', sbutil.objectToError(error));
};

Process.prototype._onExit = function (exitCode, signalCode) {
    if (signalCode) {
      this.signalCode = signalCode;
    } else {
      this.exitCode = exitCode;
    }

    this._unbind();
    //this.stdin._unbind();
    this.emit('exit', this.exitCode, this.signalCode);
  };

Process.prototype._call = function () {
  var args = _.toArray(arguments);

  if (this._attached) {
    args.unshift(sbutil.processEventId(this.id));

    this.socket.emit.apply(this.socket, args);
  } else {
    this._eventBuffer.push(args);
  }
};

Process.prototype.kill = function (signal) {
  this._call('kill', signal);
};

// resize, does nothing if its not a terminal
Process.prototype.resize = function (cols, rows) {
  this._call('resize', cols, rows);
};

module.exports = Process;
