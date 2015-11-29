'use strict';

var _ = require('lodash');

exports.eventToMethod = function (event) {
  return 'on' + _.capitalize(event);
};

exports.objectToError = function (arg) {
  console.log(arg);
  if (_.isString(arg)) {
    return new Error(arg);
  } else {
    var error = new Error(arg.message);
    error.code = arg.code;

    return error;
  }
};

exports.processEventId = function (id) {
  return 'P' + id;
};
