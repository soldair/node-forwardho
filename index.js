
var fs = require('fs')
, util = require('util')
, path = require('path')
, EventEmitter = require('events').EventEmitter
, Backoff = require('backoff')
, mkdirp = require('mkdirp')
, tailfd = require('tailfd').tail
, valuefiles = require('valuefiles')
, floody = require('floody')
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
    this.checkLogPositionDir();
    var z = this;
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
    tailPositionDir:'logpos',
    tailOptions:{}
  },
  i:0,
  buffer:'',
  bufferInfo:null,
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

    console.log('tailing logs ',logs);

    logs.forEach(function(log){
      var o = z.options.tailOptions;
      if(log.log){
        o = _ext({},o);
        _ext(o,log.options||{});
        log = log.log;
      }

      log = path.resolve(z.options.dir||process.cwd(),log);
      
      if(z.tailers[log]) {
        return;
      }
      z.tailLog(log,o);
    });

    return true;
  },
  tailLog:function(log,o){
    var z = this;

    //console.log('tailing ',log);

    fs.stat(log,function(err,stat){

      if(err && err.code != 'ENOENT') {
        console.log('error statting log ',log,err);
      } else if(!err){
        return z.readLogPosition({stat:stat},function(err,pos){
          pos = pos||0;
          if(stat.size < pos) pos = 0;
          o.start = +pos;

          console.log('starting tail of '+log+' from position ',pos,' in inode ',stat.ino,' on ',Date()+'');
          createTail();
        });
      }

      // try to create tail anyway?
      process.nextTick(function(){
        createTail();
      });

      function createTail(){

        var tail = tailfd(log,o)
        , i = 0
        , lineId = null
        , errorTimer
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
        
        tail.on('error',function(){
          console.log('OOHH snap tail of log '+log+' got an error! ',arguments);

          var t = 1000*60*5; 
            
          console.log('got an error. i\'m going to wait a while before i retry '+log+' so i dont flap');
          clearTimeout(timer);
          timer = setTimeout(function(){
            z.tailLog(log,o);
          },t);

        });

        tail.on('timeout',function(tailInfo){
          //
          this.valuefiles.rm(tailInfo.stat.ino,function(){
            console.log(tailInfo.stat.ino,' ino timed out. cleaned up the log position file'); 
          });
        });
        z.tailers[log] = tail;
      };
    });

    return true;
  },
  connect:function(){
    //console.log('connect');
    var z = this;

    if(this.connected) return;
    var opts = {host:this.options.host,port:this.options.port};
    if(!this.connection) {
      this.connected = false;
      this.connection = require('net').connect(opts.port,opts.host)
        
      this.connection.on('connect',function(err,data){
        //console.log('connected ',opts);
        if(z.buffer.length) {

          console.log('sending line buffer [',z.buffer.length,' bytes]');
          var buf = new Buffer(z.buffer);
          z.buffer = '';
          z._write(buf,z.bufferInfo);

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
      
      this.floody = floody(this.connection,100,10240);
      this.floody.on('write',function(tailInfos,bytes){

          var inos = {};
          tailInfos.forEach(function(info){
            if(!inos[info.stat.ino]) inos[info.stat.ino] = info;
            if(inos[info.stat.ino].logPos < info.logPos){
              inos[info.stat.ino] = info;
            }
          });

          Object.keys(inos).forEach(function(k){
            z.commitLogPosition(inos[k]);
          });

          if(!z.shouldPause()) z.resumeTails();
      });
    } else {
      //reconnect!
      this.connection.connect(opts.port,opts.host);
    } 
  },
  reconnect:function(){
    console.log('reconnect');
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
    z.paused = true;
    Object.keys(z.tailers).forEach(function(k){
      z.tailers[k].pause();
    });

  },
  resumeTails:function(){

    var z = this;
    if(!z.paused) return;

    z.paused = false;
    Object.keys(z.tailers).forEach(function(k){
      z.tailers[k].resume();
    });  

  },
  write:function(line,log,tailInfo,id){

    var z = this;
    if(this.filter(line)) return;
 
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


    this.floody.write(line,tailInfo);

    //
    // support control of the max buffer size per socket
    //
    if(z.shouldPause()) {
      z.pauseTails();
    }
              
  },
  shouldPause:function(){
    var p =  (this.options.maxSocketBufferSize||10240) < this.connection.bufferSize;
    return p;
  },
  format:function(line,log,id){

    var obj = {time:Date.now(),line:line,file:log};
    if(id) obj.id = id;
    obj = JSON.stringify(obj)+"\n";

    return obj;
  },
  bufferLine:function(line,tailInfo){
    console.log('buffering ',line.length,' bytes');
    this.buffer += line;
    this.bufferInfo = tailInfo;
  },
  checkedDir:null,
  checkedDirQ:[],
  checkLogPositionDir:function(cb){
    //console.log('check log pos');
    if(this.checkedDir === true) {
      return process.nextTick(function(){
        cb(null,true);
      });
    }
    
    this.checkedDirQ.push(cb);
    if(this.checkedDir === false) return;
    this.checkedDir = false;
    var z = this;
    mkdirp(this.options.tailPositionDir,function(err){
      z.checkedDir = true;
      z.valuefiles = valuefiles(z.options.tailPositionDir);
      var _cb;
      while(z.checkedDirQ.length) {
        _cb = z.checkedDirQ.shift();
        if(_cb && _cb.call) _cb(err,true);
      }
    });
  },
  readLogPosition:function(tailInfo,cb){
    var z = this;
    z.checkLogPositionDir(function(){
      z.valuefiles.get(tailInfo.stat.ino,function(err,data){
        cb(err,data);
      });
    });
  },
  commitLogPosition:function(tailInfo,cb){
    var z = this
    z.valuefiles.set(tailInfo.stat.ino,tailInfo.linePos,function(err,data){
      if(cb)cb(err,data);
    });
  },
  filter:function(line){
    var z = this;
    //
    // the "nginxDate filter" filters lines that are older than the last processed line by a minute.
    //
    if(z.options.filter === 'nginxDate') {
      var t = z.nginxDateToTime(line);
      // if i cant parse it ill have to let it through.
      if(isNaN(t)) return;

      if(!z.lastLogTime) {
        z.lastLogTime = -1;
        z.valuefiles.get('lastLogTime',function(err,time){
          time = time||0;
          z.lastLogTime = time>t?time:t;
        });
      } else if(z.lastLogTime > -1) {
        // filter this log row.
        if(z.lastLogTime-60000 > t) return true;
        if(z.lastLogTime < t) z.lastLogTime = t;
        // no need to queue up many callbacks.
        if(!z.valuefiles.writing['lastLogTime']){
          z.valuefiles.set('lastLogTime',t,function(err){
            if(err) console.log('error persisting lastLogTime',err,t);
          });
        }
      }
    }
  },
  // to ensure log data doesnt get resubmitted i have added a filter by date mechanism.
  // [23/Feb/2013:08:26:46 -0500] is the nginx date format.
  lastLogTime:0,
  nginxDateToTime:function(date){
    return (new Date(date.replace(/^.+?\[([^\[]+)\].+?$/,'$1').replace(':',' '))).getTime()
  },
  close:function(){
    this.connection.destroy();
    this.floody.stop();
    this.connection = null;
    var z = this;
    Object.keys(this.tailers).forEach(function(log){
      z.tailers[log].close();
    });    
  },
  _id:function(){
    return this.id+''+(++this.i);
  }
});

function _ext(o,o2){
  Object.keys(o2).forEach(function(k){
    o[k] = o2[k]; 
  });
}

