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
          this._destroy('internal server error');
        });
    }

    return this._boxPromise;
  }

  _bind(socket) {
    socket.once('disconnect', this._onDisconnect.bind(this, socket));

    var self = this;

    boxEvents.forEach(function (event) {
      var fn = self[sbutil.eventToMethod(event)];

      socket.on(event, function () {
        var args = _.toArray(arguments);
        var callback = args.pop();

        if (!_.isFunction(callback)) {
          // no callback => bad client
          // maybe even disconnect this guy
          return;
        }

        self._createBox()
          .then(function () {
            if (socket.connected) {
              return fn.apply(self, args);
            }
          })
          .then(callback.bind(null, null))
          .catch(function (err) {
            callback(errorToObject(err));
          });
      });
    });

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

  onReadFile(file) {
    if (!_.isString(file)) {
      debug('%s called readFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called readFile: file "%s"', this.id, file);

    return this.box.readFile(file, {
      encoding: null, // always send binary
      maxSize: 5 * 1024 * 1024 // 5 MiB
    });
  }

  onWriteFile(file, data, encoding) {
    if (!_.isString(file) || !(Buffer.isBuffer(data) || _.isString(data))) {
      debug('%s called writeFile with invalid arguments', this.id);
      throw new TypeError('Invalid arguments');
    }

    debug('%s called writeFile: file "%s", length: %s', this.id, file, data.length);

    return this.box.writeFile(file, data, {
      encoding
    });
  }

  _onExec(socket, id, command, args, options) {
    if (!Number.isSafeInteger(id) || id < 0) {
      debug('invalid event id for exec');
      return;
    }

    var self = this;
    var event = sbutil.processEventId(id);

    var process;

    debug('%s exec %s', this.id, command);

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
        if (!_.contains(['kill', 'resize'], method)) {
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

      process.on('exit', function (exitCode, signalCode) {
        socket.removeListener('disconnect', sighup);
        socket.removeAllListeners(event);

        debug('%s process %s exit (%s)', self.id, process.pid, signalCode || exitCode);

        var timeout = self._server.streamTimeout;

        if (term) {
           if (socket.connected) {
             stream.timeout(timeout);
           }
        } else {
          stdin._unbind();

          if (socket.connected) {
            // if the client is still connected, give it a grace period to
            // request the data from streams before discarding it

            // FIXME when the stream is already finished, a timeout is
            // unnecessary
            stdout.timeout(timeout);
            stdout.on('timeout', function () {
              process.stdout.unpipe();
              process.stdout.destroy();
            });

            stderr.timeout(timeout);
            stderr.on('timeout', function () {
              process.stderr.unpipe();
              process.stderr.destroy();
            });
          } else {
            // if the client disconnected, just discard everything
            process.stdout.unpipe();
            process.stdout.destroy();
            process.stderr.unpipe();
            process.stderr.destroy();
          }
        }

        socket.emit(event, 'exit', exitCode, signalCode);
      });

      // tell the client the process is ready
      socket.emit(event, 'attach');
    });
  }

  onExec(command, args, options) {
    // TODO check types? lower level function already does that kinda...

    options = _.pick(options, ['term', 'cwd']);

    if (options.term) {
      options.env = {
        TERM: 'xterm-256color'
      };
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

  Session.prototype[name] = function (files, options) {
    debug('%s called %s', this.id, event);
    return this.box[event](files, options);
  };
});

exports.Session = Session;
exports.cleanup = cleanup;
