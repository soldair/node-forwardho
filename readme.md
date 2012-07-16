[![Build Status](https://secure.travis-ci.org/soldair/node-forwardho.png)](http://travis-ci.org/soldair/node-forwardho)

## forwardho

Tails a file. it should work great. it will continue to work even if a file is unlinked rotated or truncated. It is also ok if the path doesnt exist before watching it

## Example

if you install globally you will get forwardho as a command it accepts options as arguments or reads them from the most local config.json

```sh
$> forwardho
```

as a library

```js

var forwardho = require('forwardho'),
client = forwardho({host:'localhost',port:5140,logs:['/var/log/some.log','/var/log/someother.log']});

```

to shutdown

```js
client.close();
,,,
## install

	npm install -g forwardho

### library argument structure

client = forwardho(options);


- options. supported custom options are

	```js
	{
	  "logs":[],
	  "host":"localhost",
	  "port":5140,
	  "keepAlive":true,
	  "keepAliveInterval":10000,
	  "reconnectInitialTimeout":100,
	  "reconnectMaxInterval":30000,
	  "tailOptions":{}
	}

	where tailOptions can be the following  tailfd options. right now tail options are always applied to all logs watched by this client.
	{

	"delimiter":"\n"
	//optional. defaults to newline but can be anything

	}

	// the options object is passed to watchfd as well. With watchfd you may configure

	{

	"timeout": 60*60*1000, //defaults to one hour
	//how long an inactive file descriptor can remain inactive before being cleared

	"timeoutInterval":60*5*1000 //every five minutes
	// how often to check for inactive file descriptors

	}

	//the options object is also passed directly to fs.watch and fs.watchFile so you may configure

	{
	"persistent":true, //defaults to true
	//persistent indicates whether the process should continue to run as long as files are being watched

	"interval":0, //defaults 0
	//interval indicates how often the target should be polled, in milliseconds. (On Linux systems with inotify, interval is ignored.) 
	}
	```



#### watch file and watch may behave differently on different systems here is the doc for it.

- http://nodejs.org/api/fs.html#fs_fs_writefile_filename_data_encoding_callback
- http://nodejs.org/api/fs.html#fs_fs_watch_filename_options_listener
