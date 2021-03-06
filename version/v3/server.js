const request = require('request')
const fs = require('fs')
var dateFormat = require('dateformat');
const sql_helper = require('./helper/sql_helper.js')
var Tradebot = require('./tradebot.js')
var DataMiner = require('./helper/data_miner.js')
var dataminer = new DataMiner()
const config = require('./config/config')
const bitfinex_rest = require('./helper/api/bitfinex_rest')
var http = require('http');
var path = require('path');

var async = require('async');
var socketio = require('socket.io');
var express = require('express');

var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

var messages = [];
var sockets = [];
var liveBots = []
function http_request(headers_params, cb, params) {
    console.log(headers_params)
    request(headers_params
        , function (error, response, body) {
            console.log('Response of request:')
            if (!error && response.statusCode == 200) {
                // console.log(body)
                var parsedData = '';
                try {
                    parsedData = JSON.parse(body);
                    cb(parsedData, params)

                } catch (e) {
                    console.log(e); // error in the above string (in this case, yes)!
                    cb((body), params)
                }
            } else {

                console.error("WTF HTTP REQUEST ERROR");
                console.error(error)
                if (response) {
                    console.error(response.statusCode)
                    params.StatusCode = response.statusCode;
                }
                cb(error, params)
            }
        })
}
function create_dir(dir, cb) {
    if (!fs.existsSync(dir)) {
        fs.mkdir(dir, function (err) {
            cb()
            console.log('Dir created')
        });
    } else {
        cb()
    }
}
function save_quote(subfolder, range) {
    if (!range) {
        range = ""
    }
    var dir = './quote/' + subfolder + "/";
    create_dir(dir, function (err) {
        if (err) {
            console.log('failed to create directory', err);
        } else {
            console.log('Directory created')
            var filename = dir + 'from_' + from_date + 'to_' + to_date + "_" + range + 'quote.json'
            fs.writeFile(filename, JSON.stringify(array_scrapped_big_data, null, 2));
            console.log('Quote saved! to', filename)
        }
    })
}
function object_to_url_param(obj) {
    var str = "";
    for (var key in obj) {
        if (str != "") {
            str += "&";
        }
        str += key + "=" + encodeURIComponent(obj[key]);
    }
    return str;
}
function getLastStepTimestamp() {
    now = new Date();
    dateStr = dateFormat(now, "dd/mm/yy-hh:MM:ss");
    lastStepTimestamp = now - now % (1000 * 60 * 5) //the last 5 minute timestamp
}


function updateRoster() {
    async.map(
        sockets,
        function (socket, callback) {
            socket.get('name', callback);
        },
        function (err, names) {
            broadcast('roster', names);
        }
    );
}
function broadcast(event, data) {
    sockets.forEach(function (socket) {
        socket.emit(event, data);
    });
}
function getAccountBalanceOfPairByExchange(exchange, currency, asset, cb) {
    if (exchange.toLowerCase() === 'bitfinex') {
        bitfinex_rest.getAccountBalanceOfPairByPair(currency, asset, function (err, balances) {
            cb(balances)
        })
    } else {
        cb('No API for this exchange')
    }
}
function getTradingFeesByExchange(exchange, cb) {
    if (exchange.toLowerCase() === 'bitfinex') {
        bitfinex_rest.getTradingFees(function (fees) {
            cb(fees)
        })
    } else {
        cb('No API for this exchange')
    }
}
function getPairMarketPriceByExchange(exchange, currency, asset, cb) {
    if (exchange.toLowerCase() === 'bitfinex') {
        bitfinex_rest.getPairMarketPrice(currency, asset, function (price) {
            cb(price)
        })
    } else {
        cb('No API for this exchange')
    }
}

function requireUncached(module){
    delete require.cache[require.resolve(module)]
    return require(module)
}
function getStartegyListObjPlaceholder(cb) {
    var StartDirPath = './strategies/'
    var strategies = []
    var files = fs.readdirSync(StartDirPath);
    for(var file of files){
        if(fs.lstatSync(StartDirPath+file).isFile()){
            var startegy = {name:file.split('.')[0]}
            var startJs = requireUncached(StartDirPath+file)
            startegy.parameters = startJs.parameters
            startegy.info = startJs.info
            strategies.push(startegy)
        }
    }
    cb( strategies)
    // console.log('startegies:', strategies)
}

function getDefaultSlug(obj){
    for(var el of obj){
        if(el.hasOwnProperty('default')){
            if(el.default){
                return el.slug;
                break
            }
        }
    }
    return obj[0].slug
}
function setupSocket() {
    console.log('Socket server setup')
    io.on('connection', function (socket) {
        messages.forEach(function (data) {
            socket.emit('message', data);
        });

        sockets.push(socket);

        socket.on('disconnect', function () {
            sockets.splice(sockets.indexOf(socket), 1);
            updateRoster();
        });

        var placeholder = config.placeholder
        socket.on('checkAvailableData', function (settings) {

            dataminer.getAvailableDataRanges(settings.exchanges, settings.currency, settings.asset, settings.candle_size, function (err, rangeObj) {
                socket.emit('checkAvailableData', rangeObj)
            })
        })

        socket.on('placeholder', function () {
            dataminer.getAvailableDataRanges(getDefaultSlug(placeholder.exchanges), getDefaultSlug(placeholder.currency), getDefaultSlug(placeholder.asset), getDefaultSlug(placeholder.candle_size), function (err, rangeObj) {
                placeholder.available_since = rangeObj.available_since
                placeholder.available_until = rangeObj.available_until

                getAccountBalanceOfPairByExchange(getDefaultSlug(placeholder.exchanges), getDefaultSlug(placeholder.currency), getDefaultSlug(placeholder.asset), function (balance) {
                    placeholder.balance = balance
                    placeholder.paper_trader.initial_asset_balance =config.initial_asset_balance
                    placeholder.paper_trader.initial_currency_balance = config.initial_currency_balance
                    getTradingFeesByExchange(getDefaultSlug(placeholder.exchanges), function (fee) {
                        placeholder.fee = fee
                        placeholder.paper_trader.fee = fee
                        getPairMarketPriceByExchange(getDefaultSlug(placeholder.exchanges), getDefaultSlug(placeholder.currency), getDefaultSlug(placeholder.asset), function (price) {
                            placeholder.marketPrice = price
                            getStartegyListObjPlaceholder(function (startegies) {
                                placeholder.strategy = startegies
                                socket.emit('placeholder', placeholder)
                            })
                        })
                    })
                })
            })
        })
        socket.on('stop_bot', function(id){
            console.log('TRYING TO STOP BOT WITH ID: '+id + 'amongts '+liveBots.length+' bots')
            for(var liveBot of liveBots){
                if(liveBot.id === id){
                    liveBot.bot.stopBot();
                    liveBots.splice(liveBots.indexOf(liveBot))
                    break
                }
            }
        })
        socket.on('start', function (msg) {
            console.log(msg)
            var Tradebot = require('./strategies/'+msg.strategy.name+'.js')
            var tradebot = new Tradebot(msg)
            var dataminer = new DataMiner()
            tradebot.setUpDataMiner(dataminer)
            dataminer.on('download', function (data) {
                socket.emit('status', data)
            })

            tradebot.on('init', function (data) {
                socket.emit('init', data)
            })

            tradebot.on('trade', function (data) {
                socket.emit('trade', data)
            })
            tradebot.on('stop', function (data) {
                socket.emit('stop', data)
                tradebot.getAllPastChartData(function (data) {
                    socket.emit('allChartData', data)
                })
            })
            tradebot.on('init_live', function (data) {
                socket.emit('init_live', data)
                tradebot.getAllPastChartData(function (data) {
                    socket.emit('allChartData', data)
                })
            })
            tradebot.on('status', function (data) {
                socket.emit('status', data)
            })
            switch (msg.mode) {
                case 'tradebot':
                    return
                    liveBots.push({bot:tradebot, id:liveBots.length, since: new Date().getTime()})
                    tradebot.start()
                    break;
                case 'paper_trade':
                    tradebot.on('candle_live', function (data) {
                         socket.emit('candle_live', data)
                    })
                    liveBots.push({bot:tradebot, id:liveBots.length, since: new Date().getTime()})
                    tradebot.simulation_online();
                    break
                case 'backtest':

                    tradebot.Simulation_offline();

                    break
            }
        })

        socket.on('message', function (msg) {
            console.log('message received', msg)
            var text = String(msg || '');

            if (!text)
                return;

            socket.get('name', function (err, name) {
                var data = {
                    name: name,
                    text: text
                };

                broadcast('message', data);
                messages.push(data);
            });
        });

        socket.on('identify', function (name) {
            socket.set('name', String(name || 'Anonymous'), function (err) {
                updateRoster();
            });
        });
    });
}
function keepPingingMyself() {
    setInterval(function () {
        console.log('TRYING TO PING MYSELF')
        var url = "https://cryptotraderbottolotra.herokuapp.com/";
        http_request({url: url, method: 'GET'}, function (data, params) {
            console.log('PINGING MYSELF SUCCESSFULLY')
            // console.log(data.trades[0], params)
        }, '')
    }, 300000); // every 5 minutes (300000)
}
function runServer() {
    console.log('Server+ setup')
    router.use(express.static(path.resolve(__dirname, 'client')));

    server.listen(process.env.PORT || 3200, process.env.IP || "localhost", function () {
        var addr = server.address();
        console.log("Chat server listening at", addr.address + ":" + addr.port);
    });
    setupSocket()
    // keepPingingMyself()


}

//FEATURES
runServer()


