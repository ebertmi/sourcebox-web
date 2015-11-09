'use strict';

// only require the functions actually used by the client lib in order to keep
// the filesize as low as possible

module.exports = {
  isFunction: require('lodash/lang/isFunction'),
  isString: require('lodash/lang/isString'),
  toArray: require('lodash/lang/toArray')
};
