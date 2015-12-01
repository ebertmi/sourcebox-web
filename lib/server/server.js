'use strict';

var Promise = require('bluebird');
var io = require('socket.io');
var Sourcebox = require('@sourcebox/sandbox');
var _ = require('lodash');
var debug = require('debug')('sourcebox:server');

var session = require('./session');

var shutdown = _.once(function (signal) {
  if (signal === 'SIGHUP') {
    // node crashes when it tries to write to stdout/stderr after the terminal
    // is gone. override the stdout/stderr write methods to prevent that.
    process.stdout.write = _.noop;
    process.stderr.write = _.noop;
  }

  debug('got %s, shutting down', signal);

  session.cleanup('server shutting down')
    .each(function (result) {
      if (result.isRejected()) {
        // cleanup failed for at least one session/sandbox;
        process.exit(1);
      }
    }).then(function () {
      process.exit(0);
    });
});

var signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];

signals.forEach(function (signal) {
  process.on(signal, function () {
    shutdown(signal);
  });
});

function disableCleanup() {
  signals.forEach(function (signal) {
    process.removeAllListeners(signal);
  });
}

// an auth method has to return a promise (or a resolved value) or throw an
// error.
// returned value must be an unique identifier for this client!

var defaultOptions = {
  auth: socket => socket.id,
  authTimeout: 10 * 1000, // 10 seconds
  session: session.Session,
  sessionTimeout: 5 * 60 * 1000, // 5 minutes
  streamTimeout: 10 * 1000, // 10 seconds
  io: {
    serveClient: false
  }
};

class Server {
  constructor(sourcebox, options) {
    if (sourcebox instanceof Sourcebox) { // might fail if different versions are used. dunno
      this.source = sourcebox;
    } else if (_.isString(sourcebox)){
      this.source = new Sourcebox(sourcebox);
    } else {
      throw new TypeError('sourcebox must be a sourcebox instance or a path');
    }

    options = _.defaults({}, options, defaultOptions);

    if (options.io instanceof io) { // hmm, this might fail if different socket.io versions are used
      this.io = options.io;
    } else if (_.isPlainObject(options.io)) {
      this.io = io(options.io);
    } else {
      throw new TypeError('options.io must be a socket.io instance or io options object');
    }

    this.io.on('connection', this._onConnection.bind(this));

    this.auth = options.auth;
    this.authTimeout = options.authTimeout;
    this.Session = options.session;
    this.sessionTimeout = options.sessionTimeout;
    this.streamTimeout = options.streamTimeout;

    this._sessions = {};
  }

  _onConnection(socket) {
    global.socket = socket;
    debug('socket %s connected from %s', socket.id, socket.handshake.address);

    new Promise(function (resolve) {
      socket.once('auth', resolve);
    })
      .timeout(this.authTimeout, 'Authentication timed out')
      .then(this.auth.bind(null, socket))
      .bind(this)
      .then(function (id) {
        if (!_.isString(id)) {
          throw new TypeError('Invalid auth id');
        }

        debug('%s authenticated as %s', socket.id, id);

        var sessions = this._sessions;
        var session = sessions[id];

        if (!session) {
          session = new this.Session(this, id);
          sessions[id] = session;

          session.once('destroy', function () {
            delete sessions[this.id];
          });
        }

        session.addSocket(socket);
      })
      .catch(function (error) {
        var message = error.message || error.toString();
        debug('socket %s failed to auth: %s', socket.id, message);
        socket.emit('fatal', 'auth failed: ' + message);
        socket.disconnect();
      });
  }

  /**
   * Creates a new http.Server and listens for socket connections.
   */
  listen(port, options, callback) {
    // TODO check callback, promisify maybe?
    return this.io.listen(port || 80, options, callback);
  }

  /**
   * Attaches to an existing http.Server and captures update requests.
   */
  attach(server, options) {
    return this.io.attach(server, options);
  }
}

module.exports = exports = Server;
exports.Session = session.Session;
exports.disableCleanup = disableCleanup;
