'use strict';

// don't require all of lodash when building the client lib
module.exports = {
  capitalize: require('lodash/capitalize'),
  isArray: require('lodash/isArray'),
  isFunction: require('lodash/isFunction'),
  isPlainObject: require('lodash/isPlainObject'),
  isString: require('lodash/isString'),
  toArray: require('lodash/toArray'),
  isInteger: require('lodash/isInteger')
};
