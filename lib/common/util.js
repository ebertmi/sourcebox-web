'use strict';

var _ = require('lodash');

exports.eventToMethod = function (event) {
  //return 'on' + _.upperFirst(event[0]) + event.slice(1);
  return 'on' + _.upperFirst(event);
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
