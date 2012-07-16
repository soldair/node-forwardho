#!/usr/bin/env node
var config = require('confuse')()
 , client = require('../index.js')
 ;

client(config);
