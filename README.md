sourcebox/web
=============

Server and client sandbox libraries.

## Server

See `examples/server.js` for a usage example.

## Client

It is recommended to use [browserify](http://browserify.org/) to require this
module on the client side.

Alternatively, you can run `npm install && npm run-script bundle` in the
package directory to create a standalone UMD (Universal Module Definition)
bundle that contains all dependencies.

The created bundle can then be used with both CommonJS or AMD module loaders.
If no supported module loader is detected, a global `Sourcebox` variable will
be created.
