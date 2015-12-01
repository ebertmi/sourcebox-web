'use strict';

// don't require all of lodash when building the client lib
module.exports = {
  capitalize: require('lodash/string/capitalize'),
  isArray: require('lodash/lang/isArray'),
  isFunction: require('lodash/lang/isFunction'),
  isPlainObject: require('lodash/lang/isPlainObject'),
  isString: require('lodash/lang/isString'),
  toArray: require('lodash/lang/toArray')
};
