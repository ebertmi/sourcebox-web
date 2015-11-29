'use strict';

// multiplexes node streams over event emitters like socket.io, automatically
// managing the flow as to not overwhelm resources

var util = require('util');
var Duplex = require('stream').Duplex;

var debug = require('debug')('sourcebox:remotestream');

var client = process.browser;

function streamEventId(id) {
  return 'S' + id;
}

function RemoteStream(socket, id, wait) {
  RemoteStream.super_.call(this);

  // whether we requested a read and are waiting for data
  this._mayReceive = false;

  // whether the remote requested a read and is waiting for data
  this._maySend = false;

  // pending write callback
  this._doWrite = null;

  this.socket = socket;
  this.id = id;

  this._bind();

  if (!wait) {
    this.ready();
  }
}

util.inherits(RemoteStream, Duplex);

RemoteStream.prototype._bind = function () {
  this.socket.on(streamEventId(this.id), this._onStream.bind(this));

  var self = this;

  this._onDisconnect = function () {
    self._unbind();
  };

  this.socket.once('disconnect', this._onDisconnect);

  this.once('finish', function () {
    if (this._isReady) {
      this._emit('W', null);
    } else {
      this._ended = true;
    }

    this.emit('done');

    this._clearTimeout();
    this._unbind();
  });

};

RemoteStream.prototype._unbind = function () {
  this.push(null);

  this.socket.removeAllListeners(streamEventId(this.id));
  this.socket.removeListener('disconnect', this._onDisconnect);
};

RemoteStream.prototype._emit = function (method, data) {
  this.socket.emit(streamEventId(this.id), method, data);
};

RemoteStream.prototype.timeout = function (ms) {
  this._timeoutTime = ms;

  if (!this._maySend) {
    this._setTimeout();
  }
};

RemoteStream.prototype._setTimeout = function () {
  if (this._timeoutTime) {
    var self = this;

    this._timeout = setTimeout(function () {
      debug('%s timed out', self.id);
      self.emit('done');

      // maybe only emit null when we are the right type of stream?
      self._emit('W', null);
      self._unbind();
    }, this._timeoutTime);
  }
};

RemoteStream.prototype._clearTimeout = function () {
  if (this._timeout) {
    clearTimeout(this._timeout);
    this._timeout = null;
  }
};

RemoteStream.prototype.ready = function () {
  this._isReady = true;

  if (this._ended) {
    this._emit('W', null);
  }
  if (this._readCalled) {
    this._readCalled = false; // so we dont call _read again by accident
    this._read();
  }
};

RemoteStream.prototype._onStream = function (method, data) {
  if (method === 'R') {
    this._onRead();
  } else if (method === 'W') {
    this._onWrite(data);
  } else {
    debug('%s invalid stream method: %s', this.id, method);
  }
};

RemoteStream.prototype._read = function () {
  if (!this._isReady) {
    this._readCalled = true;
    return;
  }

  if (!this._mayReceive) {
    debug('%s requesting data', this.id);

    this._emit('R');
    this._mayReceive = true;
  }
};

RemoteStream.prototype._write = function (chunk, encoding, callback) {
  var self = this;

  if (client) {
    chunk = chunk.toArrayBuffer();
  }

  function doWrite() {
    debug('%s writing %d bytes', self.id, chunk.length);

    self._emit('W', chunk);
    self._maySend = false;
    self._doWrite = null;
    self._setTimeout();
    callback();
  }

  if (this._maySend) {
    // only write when the remote requested a read
    doWrite();
  } else {
    // otherwise save the callback and wait for a read
    this._doWrite = doWrite;
  }
};

// remote wants to read
RemoteStream.prototype._onRead = function () {
  debug('%s remote requested data', this.id);
  this._clearTimeout();
  // if we have a write cb pending, use that
  // otherwise wait and remember that the remote wants data

  if (this._doWrite) {
    this._doWrite();
  } else {
    this._maySend = true;
  }
};

RemoteStream.prototype._onWrite = function (chunk) {
  if (this._readableState.ended) {
    debug('%s received data after end', this.id);
    return;
  } else if (chunk === null) {
    debug('%s received end of stream', this.id);
    this.push(null);
    this._unbind();
  } else if (this._mayReceive) {
    if (!Buffer.isBuffer(chunk)) {
      try {
        chunk = new Buffer(chunk);
      } catch (err) {
        debug('%s received malformed data:', this.id, err);
        return;
      }
    }

    this._mayReceive = false;

    debug('%s received %d bytes', this.id, chunk.length);

    this.push(chunk);
  } else {
    debug('%s received unrequested data', this.id);
  }
};

module.exports = exports = RemoteStream;
