var test = require('tap').test;
var forwardho = require('../index.js');


test('client interface',function(t){
  t.ok(typeof forwardho == 'function','should export function');
  t.ok(typeof forwardho.ForwardHo == 'function','should export the client constructor');
  t.end();
});
