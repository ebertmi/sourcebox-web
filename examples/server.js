'use strict';

var Server = require('../lib/server/server');
var Session = Server.Session;

// all server options are optional, defaults are shown
var server = new Server(process.env.SOURCEBOX, {
  // authentication method, see auth section
  auth: socketAuth,

  // time after connection for the client to send the auth message
  authTimeout: 10 * 1000,

  // for customization, pass a session constructor
  session: Session,

  // time until the session is destroyed after the last client disconnects
  sessionTimeout: 10 * 1000,

  // grace period for the client to request data from streams after a process
  // exited
  streamTimeout: 10 * 1000,

  // 'io' can be either a socket.io instance or an options object that will be
  // passed to socket.io constructor
  io: {
    serveClient: false
  }
});

// create a new http server and listen on a port
server.listen(80);

// or attach to an existing http/https server
//server.attach(httpsServer)

// auth functions must return a string (or a promise for a string) or throw.
// the string will be used to assign clients to sessions

// socket "auth", each socket gets a new session (default)
function socketAuth(socket) {
  return socket.id;
}

// IP "auth", assigns all sockets from the same IP to the same session
function ipAuth(socket) {
  return socket.handshake.address;
}

// async "dumb database" auth
function dbAuth(socket, data) {
  // assumes that getUser() returns a Promise
  return db.getUser(data.username)
    .then(function (user) {
      if (user.secret === data.secret) {
        return data.username;
      } else {
        throw new Error('invalid password');
      }
    });
}

// JSON web token auth
function jwtAuth(socket, token) {
  // verify() throws for invalid tokens which will disconnect the client
  var decoded = jwt.verify(token, 'theSecretOrPublicKey');

  // this assumes that the token contains a unique username
  return decoded.username;
}

// subclassing Session allows customization

// the types of the arguments of each method are guaranteed to be correct.
// however, sublevel objects are not checked (e.g. the onExec arguments array
// might contain non-string objects)
//
// methods must return a promise or throw an error except 'onExec', which must
// return an AttachedProcess object or throw.
class CustomSession extends Session {
  onWriteFile(file, buffer) {
    if (buffer.length > 1024) {
      throw new Error('File too big');
    }

    return super.onWriteFile(file, buffer);
  }

  onExec(command, args, options) {
    args = ['--', command].concat(args);

    return this.box.exec('cowsay', args, {
      term: options.term
    });
  }
}

