#!/usr/bin/env node
var config = require('confuse')({dir:process.cwd()})
 , client = require('../index.js')
 ;

client(config);
