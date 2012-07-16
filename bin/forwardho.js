#!/usr/bin/env node
var config = require('confuse')({dir:process.cwd(),files:['forwardho.json']})
 , client = require('../index.js')
 ;

client(config);
