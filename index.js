
var fs = require('fs')
, util = require('util')
, path = require('path')
, EventEmitter = require('events').EventEmitter
, Backoff = require('backoff')
, tailfd = require('tailfd').tail
;

module.exports = function(opts){
  var client = new ForwardHo(opts);
  client.connect();
  client.tail(opts.logs);
  client.id = Date.now()+''+Math.random();
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
  i:0,
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
      var o = z.options.tailOptions;
      if(log.log){
        o = _ext({},o);
        _ext(o,log.options||{});
        log = log.log;
      }

      log = path.resolve(__dirname,log);
      
      if(z.tailers[log]) {
        return;
      }

      console.log('tailing ',log);

      var tail = tailfd(log,o)
      ,i = 0
      ,lineId = null
      ;

      tail.on('line',function(line,tailInfo){
        z.write(line,log,tailInfo,lineId);
        if(lineId) lineId = null;
      });

      // if theline is too long just send it as a line but tag it with line id for later reassembly
      tail.on('line-part',function(line,tailInfo){
        lineId = z._id();
        z.write(line,log,tailInfo,lineId);
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

          console.log('sending line buffer [',z.buffer.length,' bytes]');
          z.writeBuffer();
          z.connected = true;

        } else {
          z.connected = true;
        }

        z.resumeTails();
      });

      if(this.options.keepAlive) this.connection.setKeepAlive(this.options.keepAlive,this.options.keepAliveInterval);

      this.connection.on('end',function(){
        z.pauseTails();
        console.log('connection was closed.')
        z.connected = false;
        z.reconnect();  
      });

      this.connection.on('error',function(err){
        z.pauseTails();
        console.log('connection error. ',err.code,opts);
        z.connected = false;
        z.reconnect();
      });

      this.connection.on('drain',function(){
        z.resumeTails();
      });
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
  pauseTails:function(){
    var z = this;
    z.pause = true;
    Object.keys(z.tailers).forEach(function(k){
      z.tailers[k].pause();
    });
  },
  resumeTails:function(){
    var z = this;
    z.paused = false;
    Object.keys(z.tailers).forEach(function(k){
      z.tailers[k].resume();
    });   
  },
  write:function(line,log,tailInfo,id){
    var z = this;
    line = z.format(line,log,id);
    if(z.connected) {
      z._write(line,tailInfo);
    } else {
      this.pauseTails();
      this.bufferLine(line,tailInfo);
    }
  },
  _write:function(line,tailInfo){
    var z = this;
    // 
    // just write it
    //
    line = line instanceof Buffer?line:new Buffer(line);

    var result = this.connection.write(line,function(){
      // i have successfully transfered these bytes...
      z.commitLogPosition(tailInfo);
      // if i dont have too much in memory get it going again.
      if(!z.shouldPause()) z.resumeTails();
    });

    //
    // support control of the max buffer size per socket
    //
    if(z.shouldPause()) {
      z.pauseTails();
    }
              
  },
  shouldPause:function(){
    return (this.options.maxSocketBufferSize||10240) < this.connection.bufferSize;
  },
  format:function(line,log,id){
    var obj = {time:Date.now(),line:line,file:log};
    if(id) obj.id = id;
    return JSON.stringify(obj)+"\n";
  },
  bufferLine:function(line,tailInfo){
    console.log('buffering ',line.length,' bytes');
    this.buffer += line;
  },
  commitLogPosition:function(tailInfo,cb){

    var inode = tailInfo.stat.ino
    , linePos = tailInfo.linePos 
    , logposdir = this.options.log_position_dir||'./'
    ;
    
    fs.writeFile(logposdir+'logpos-'+inode,linePos,function(err,data){
      if(err) console.log('error committing log position! ',err);
      if(cb) cb(err,data);
    });
  },
  close:function(){
    this.connection.destroy();
    this.connection = null;
    var z = this;
    Object.keys(this.tailers).forEach(function(log){
      z.tailers[log].close();
    });    
  },
  _id:function(){
    return this.id+''+(++i);
  }
});

function _ext(o,o2){
  Object.keys(o2).forEach(function(k){
    o[k] = o2[k]; 
  });
}

