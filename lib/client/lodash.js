'use strict';

// don't require all of lodash when building the client lib
module.exports = {
  toArray: require('lodash/lang/toArray'),
  isFunction: require('lodash/lang/isFunction'),
  isPlainObject: require('lodash/lang/isPlainObject')
};
