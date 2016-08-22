'use strict';

var events = require('events');

var Promise = require('bluebird');
var _ = require('lodash');
var debug = require('debug')('sourcebox:session');

var sbutil = require('../common/util');
var RemoteStream = require('../common/remotestream');

// sessions that are alive or in the process of being destroyed
var activeSessions = {};

function cleanup(reason) {
  return Promise.all(_.map(activeSessions, function (session) {
    return session._destroy(reason)
      .reflect();
  }));
}

function errorToObject(err) {
  return _.pick(err, ['message', 'code']);
}

function cleanupStream(src, dst, timeout) {
  function clean() {
    src.unpipe();
    src.destroy();
  }

  if (dst._writableState.finished) {
    clean();
  } else {
    dst.timeout(timeout);
    dst.once('done', clean);
  }
}

// these events trigger a sandbox creation and call the corresponding
// session.onEVENT method when the sandbox is ready
var fsWraps = ['mkdir', 'rm', 'cp', 'ln'];
var boxEvents = ['readFile', 'writeFile'].concat(fsWraps);

class Session extends events.EventEmitter {
  constructor (server, id) {
    debug('created %s', id);

    super();

    this.id = id;
    this._sockets = {};
    this._server = server;

    activeSessions[id] = this;
  }

  _createBox() {
    if (!this._boxPromise) {
      this._boxPromise = this._server.source.box();

      this._boxPromise
        .bind(this)
        .then(function (box) {
          debug('%s created sandbox %s', this.id, box.name);

          this.box = box;
        })
        .catch(function (err) {
          // fatal, couldnt create sandbox
          debug('%s failed to create sandbox: %s', this.id, err.message);
          this._destroy('Internal Server Error');
        });
    }

    return this._boxPromise;
  }

  _bind(socket) {
    socket.once('disconnect', this._onDisconnect.bind(this, socket));

    var self = this;

    for (var event of boxEvents) {
      (function (eventName) {
        var fn = self['_' + sbutil.eventToMethod(eventName)];
        socket.on(eventName, function () {
            debug('socket.on ', eventName );
            var args = _.toArray(arguments);
            var callback = args.pop();

            if (!_.isFunction(callback)) {
                // no callback => bad client
                // maybe even disconnect this guy#

                debug('event without callback function, bad client', eventName);
                return;
            }

            self._createBox()
            .then(() => {
                if (socket.connected) {
                    return fn.apply(self, args);
                }
            })
            .then(callback.bind(null, null))
            .catch(function (err) {
                callback(errorToObject(err));
            });
        });
      })(event);
    };

    // exec is special because it does not return a promise
    socket.on('exec', function () {
      var args = _.toArray(arguments);
      args.unshift(socket);

      self._createBox()
        .then(function () {
          if (socket.connected) {
            self._onExec.apply(self, args);
          }
        }, _.noop)
        .catch(function (err) {
          debug('%s error in exec: %s', self.id, err);
        });
    });
  }

  addSocket(socket) {
    if (socket.connected) {
      debug ('added socket %s to %s', socket.id, this.id);
      this._sockets[socket.id] = socket;
      this._bind(socket);
      clearTimeout(this.timeout);
    }
  }

  removeSocket(socket) {
    socket = this._sockets[socket.id];

    if (socket) {
      socket.disconnect();
    }
  }

  _onReadFile(file) {
    if (!_.isString(file)) {
      debug('%s called readFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called readFile: file "%s"', this.id, file);

    return this.onReadFile(file);
  }

  onReadFile(file) {
    return this.box.readFile(file, {
      encoding: null, // always send binary
      maxSize: 5 * 1024 * 1024 // 5 MiB
    });
  }

  _onWriteFile(file, data) {
    if (!_.isString(file) || !Buffer.isBuffer(data)) {
      debug('%s called writeFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called writeFile: file "%s", bytes: %s', this.id, file, data.length);

    return this.onWriteFile(file, data);
  }

  onWriteFile(file, data) {
    return this.box.writeFile(file, data);
  }

  _onExec(socket, id, command, args, options) {
    if (!Number.isSafeInteger(id) || id < 0) {
      debug('invalid event id for exec');
      return;
    }

    if (!_.isString(command) || !_.isArray(args) || !_.isPlainObject(options)) {
      debug('%s called exec with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    var self = this;
    var event = sbutil.processEventId(id);

    var process;

    debug('%s called exec:', this.id, command, args, options);

    try {
      process = this.onExec(command, args, options);
    } catch (err) {
      debug('%s exec failed: %s', this.id, err.message);

      socket.emit(event, 'error', errorToObject(err));
      return;
    }

    process.on('error', function (err) {
      socket.emit(event, 'error', errorToObject(err));
    });

    process.on('attach', function (pid) {
      function sighup() {
        process.kill('SIGHUP');
      }

      if (socket.disconnected) {
        // if the user disconnected during the time it took to attach the
        // process, there is no point in setting up streams and process
        // methods.

        sighup();
        return;
      } else {
        socket.once('disconnect', sighup);
      }

      // set up "process methods" through which the process can be controlled
      // by the client
      socket.on(event, function (method) {
        if (!_.includes(['kill', 'resize'], method)) {
          debug('%s invalid process method: %s', self.id, method);
          return;
        }

        var args = _.toArray(arguments);
        args.shift();

        debug('%s %s process %d:', self.id, method, pid, args);

        try {
          process[method].apply(process, args);
        } catch (err) {
          debug('%s %s process %d failed: %s', self.id, method, pid, err.message);
        }

      });

      var term = process.stdin === process.stdout;

      // set up the streams
      if (term) {
        // terminal, single stream

        var stream = new RemoteStream(socket, id);
        stream.pipe(process.stdin).pipe(stream);
      } else {
        // not a terminal, create three streams

        var stdin = new RemoteStream(socket, id + '.0');
        var stdout = new RemoteStream(socket, id + '.1');
        var stderr = new RemoteStream(socket, id + '.2');

        stdin.pipe(process.stdin);

        process.stdout.pipe(stdout);
        process.stderr.pipe(stderr);
      }

      // create additional streams
      let streams = {};
      if (options.streams && _.isInteger(options.streams)) {

        for (let i = 0; i < options.streams; i++) {
          let fd = i + 3; // begin after stdio streams

          // Make explicit check here, to avoid type casting!
          let objectMode = options.streamsObjectMode[i] === true;
          let remotestream = new RemoteStream(socket, `${id}.${fd}`, false, { objectMode: objectMode });

          stream.pipe(remotestream).pipe(stream);
        }
      }

      process.on('exit', function (exitCode, signalCode) {
        socket.removeListener('disconnect', sighup);
        socket.removeAllListeners(event);

        debug('%s process %s exit (%s)', self.id, process.pid, signalCode || exitCode);

        var timeout = self._server.streamTimeout;

        if (term) {
           if (socket.connected) {
             cleanupStream(process.stdin, stream, timeout);
           }
        } else {
          stdin._unbind();

          if (socket.connected) {
            // if the client is still connected, give it a grace period to
            // request the data from streams before discarding it

            cleanupStream(process.stdout, stdout, timeout);
            cleanupStream(process.stderr, stderr, timeout);
          } else {
            // if the client disconnected, just discard everything
            process.stdout.unpipe();
            process.stdout.destroy();
            process.stderr.unpipe();
            process.stderr.destroy();
          }
        }

        // cleanup streams
        for (var fd in streams) {
          if (socket.connected) {
            cleanupStream(process.stdio[fd], streams[fd], timeout);
          } else {
            process.stdio[fd].unpipe();
            process.stdio[fd].destroy();
          }
        }

        socket.emit(event, 'exit', exitCode, signalCode);
      });

      // tell the client the process is ready
      socket.emit(event, 'attach');
    });
  }

  onExec(command, args, options) {
    options = _.pick(options, ['term', 'cwd', 'env', 'streams', 'streamsObjectMode']);

    if (options.term) {
      options.env = Object.assign({}, options.env, {
        TERM: 'xterm-256color'
      });
    }

    return this.box.attach(command, args, options);
  }

  _onDisconnect(socket) {
    socket.removeAllListeners();
    debug('removed %s from %s', socket.id, this.id);
    delete this._sockets[socket.id];

    if (_.isEmpty(this._sockets) && !this._destroyed) {
      var timeout = this._server.sessionTimeout;

      debug('%s will time out in %dms', this.id, timeout);

      this.timeout = setTimeout(function () {
        this._destroy('time out')
          .catch(_.noop);
      }.bind(this), timeout);
    }
  }

  _destroy(reason) {
    if (this._destroyed) {
      return this._destroyed;
    }

    debug('destroying %s due to %s', this.id, reason);

    if (this._boxPromise) {
      // we have a sandbox or a sandbox in the process of being created

      this._destroyed = this._boxPromise
        .bind(this)
        .then(function (box) {
          // if it gets created, destroy it

          return box.destroy()
            .bind(this)
            .catch(function (err) {
              debug('%s: failed to destroy box %s: ',
                    this.id, box.name, err.message);
              throw err;
            });
        }, function () {
          // if creation fails there is nothing to destroy
          // the error is already handled earlier
        });
    } else {
      this._destroyed = Promise.bind(this);
    }

    _.forEach(this._sockets, function (socket) {
      socket.removeAllListeners();
      socket.emit('fatal', reason);
      socket.disconnect();
    });

    this.emit('destroy', reason);

    return this._destroyed
      .finally(function () {
        delete activeSessions[this.id];
      });
  }
}

// hmmm, cant do this inside the class block :C

fsWraps.forEach(function (event) {
  var name = sbutil.eventToMethod(event);

  Session.prototype['_' + name] = function (files, options) {
    if (!_.isArray(files) || !_.isPlainObject(options)) {
      debug('%s called %s with invalid arguments', this.id, event);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called %s:', this.id, event, files, options);

    return this[name](files, options);
  };

  Session.prototype[name] = function (files, options) {
    return this.box[event](files, options);
  };
});

exports.Session = Session;
exports.cleanup = cleanup;
