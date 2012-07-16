
var fs = require('fs')
, util = require('util')
, EventEmitter = require('events').EventEmitter
, Backoff = require('backoff')
, tailfd = require('tailfd').tail
;

module.exports = function(opts){
  var client = new ForwardHo(opts);
  client.connect();
  client.tail(opts.logs);
  return client;
}

module.exports.ForwardHo = ForwardHo;

function ForwardHo(opts){
    _ext(this.options,opts||{});
}

util.inherits(ForwardHo,EventEmitter);

_ext(ForwardHo.prototype,{
  options:{
    logs:[],
    host:"localhost",
    port:5140,
    keepAlive:true,
    keepAliveInterval:10000,
    reconnectInitialTimeout:100,
    reconnectMaxInterval:30000,
    tailOptions:{}
  },
  buffer:'',
  connection:false,
  connected:false,
  tailers:{},
  tail:function(logs){
    var z = this;
    if(!this.tailers) this.tailers = {};
    
    if(typeof logs == 'string') logs = [logs];
    else if(!logs) {
      if(!this.tailers.length) return this.emit('error',new Error('log files required!'));
      else return this.emit('fail',new Error('invalid log specified'));
    }

    if(!logs.forEach) return this.emit('error',new Error('logs to tail is not a string or array'));

    logs.forEach(function(log){
      //todo make absolute path.
      if(z.tailers[log]) {
        return;
      }
      console.log('tailing ',log);
      var tail = tailfd(log,z.options.tailOptions);

      tail.on('line',function(line,tailInfo){
        z.write(line,log,tailInfo);
      });

      z.tailers[log] = tail;
    });

    return true;
  },
  connect:function(){
    var z = this;

    if(this.connected) return;
    var opts = {host:this.options.host,port:this.options.port};
    if(!this.connection) {
      this.connected = false;
      this.connection = require('net').connect(opts)
        
      this.connection.on('connect',function(err,data){
        console.log('connected ',opts);
        if(z.buffer.length) {
          console.log('flushing line buffer [',z.buffer.length,' bytes]');
          z.connection.write(z.buffer,function(){
            console.log('flushed!');
            z.connected = true;
          });
          z.buffer = '';
        } else {
          z.connected = true;
        }
      });

      if(this.options.keepAlive) this.connection.setKeepAlive(this.options.keepAlive,this.options.keepAliveInterval);

      this.connection.on('end',function(){
        console.log('connection was closed.')
        z.connected = false;
        z.reconnect();  
      });

      this.connection.on('error',function(err){
          console.log('connection error. ',err.code,opts);
          z.connected = false;
          z.reconnect();
      })
    } else {
      //reconnect!
      this.connection.connect(opts);
    } 
  },
  reconnect:function(){
    var z = this;
    if(!this.backoff) {
      this.backoff = new Backoff({
        initialTimeout:this.options.reconnectInitialTimeout,
        maxTimeout:this.options.reconnectMaxInterval 
      });

      this.backoff.on('backoff',function(number,delay){

        if(z.connected) return z.backoff.reset();
        
        console.log('reconnect attempt ' + number + ' waited ' + delay + 'ms');
        if(!z.backoff.backoffInProgress){
          z.connect();
          z.backoff.backoff();
        }
      });

      this.backoff.on('error',function(err){
        console.log('backoff error! ',err);
        z.backoff = null;
      });
    }

    if(!z.backoff.backoffInProgress){
      this.backoff.backoff();
    }
  },
  write:function(line,log){
    line = this.format(line,log);
    if(this.connected) {
      //console.log('writing ',line.length,' bytes');
      this.connection.write(line);
    }else this.bufferLine(line); 
  },
  format:function(line,log){
    return JSON.stringify({time:Date.now(),line:line,file:log})+"\n";
  },
  bufferLine:function(line){
    console.log('buffering ',line.length,' bytes');
    this.buffer += line;
  },
  close:function(){
    this.connection.destroy();
    this.connection = null;
    var z = this;
    Object.keys(this.tailers).forEach(function(log){
      z.tailers[log].close();
    });    
  }
});

function _ext(o,o2){
  Object.keys(o2).forEach(function(k){
    o[k] = o2[k]; 
  });
}

