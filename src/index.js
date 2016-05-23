import merge from './internal/merge';
import jsSHA from 'jssha';
import ErrorStackParser from 'error-stack-parser';

type Value = // TODO: Gauge
  { event: string };

type Fields =
  { errors: ?Array<Error> };

type Message =
  { name: ?Array
  ; value: Value // TODO: value: Event|Gauge
  ; timestamp: ?Date|?string
  ; context: ?Object
  ; fields: ?Fields
  ; session: ?Object // TODO: remove when removed from logary
  ; level: string }

export const LogLevel = {
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',

  lessThan(a: string, b: string) {
    const order = {
      VERBOSE: 0,
      DEBUG: 1,
      INFO: 2,
      WARN: 3,
      ERROR: 4,
      FATAL: 5
    };
    const A = a.toUpperCase();
    const B = b.toUpperCase();
    if (order.hasOwnProperty(A) && order.hasOwnProperty(B)) {
      return order[A] < order[B];
    } else return false;
  }
};

export const Message = {
  defaultLevel: LogLevel.DEBUG,
  defaultEventLevel: LogLevel.INFO,

  create({ template, fields, context, level }) {
    return {
      value: { event: template },
      fields,
      context,
      level: level || this.defaultLevel
    };
  },

  event(template, level, fields = {}, context = {}) {
    return this.create({
      template,
      fields,
      context,
      level: level || this.defaultEventLevel
    });
  },

  eventError(template, error: Error, fields = {}, context = {}) {
    const errors = [error];
    return this.create({
      template,
      level: LogLevel.ERROR,
      fields: {
        ...fields,
        errors: errors,
      },
      context
    });
  }
};

export const HashUtils = {
  normalise(o: Object): string {
    return traverse(
      o, '',
      (state, key, value) => {
        //console.log('####### state', JSON.stringify(state), 'key', key, 'value', value);
        return state + key + "\t" + value + "\n"
      }
    );
  }
};

type Middleware = (next:Function) => (m: Message) => Message;

export const Middleware = {
  messageId: next => msg => {
    // https://github.com/Caligatio/jsSHA
    const hasher = new jsSHA('SHA-256', 'TEXT'),
          messageId = msg.messageId ||
                      hasher.update(HashUtils.normalise(msg)) ||
                      hasher.getHash('HEX');
    return next({
      messageId,
      ...msg
    });
  },

  stacktrace: next => msg => {
    if (msg.fields && msg.fields.errors && msg.fields.errors.length > 0) {
      const allErrors = msg.fields.errors.map(error => ErrorStackParser.parse(error));
      return Promise.all(allErrors).
        then(newErrors => {
          //console.log('newErrors', newErrors);
          return next({
            ...msg,
            fields: {
              ...msg.fields,
              errors: newErrors
            }
          });
        },
        internalError => next(msg));
    } else {
      return next(msg);
    }
  },

  timestamp: next => msg => next(merge(msg, {
    timestamp: (typeof msg.timestamp === 'Date' ?
                   Number((msg.timestamp.getTime() + '000000')) :
                   Number(Date.now() + '000000'))
  })),

  minLevel(level: string) {
    return next => msg =>
        LogLevel.lessThan(msg.level, level) ?
          msg :
          next(msg);
  }
};

export default function Logary(service: string, target, mid) {
  const missingTarget = msg => {
    // eslint-disable-next-line
    if (console) { console.warn('No target specified in logary.'); }
    return Promise.resolve(msg);
  };

  const missingMid = [
    Middleware.minLevel(LogLevel.INFO),
    Middleware.messageId,
    Middleware.stacktrace,
    Middleware.timestamp
  ];

  const actualMid =
    (!!mid ? (Array.isArray(mid) ? mid : [ mid ])
           : missingMid);

  this.service = service;
  this.target = target || missingTarget;
  this.middleware = actualMid;
}

type Logger = (m: Message) => Message;

type FinalLogger = (m: Message) => Promise;

/**
 * Composes single-argument functions from right to left. The rightmost
 * function can take multiple arguments as it provides the signature for
 * the resulting composite function.
 *
 * @param {...Function} funcs The functions to compose.
 * @returns {Function} A function obtained by composing the argument functions
 * from right to left. For example, compose(f, g, h) is identical to doing
 * (...args) => f(g(h(...args))).
 */
export function compose(...funcs) {
  if (funcs.length === 0) {
    return arg => arg;
  } else {
    // Alternative formulation with higher-order functions only.
    // return funcs.reduceRight((composed, f) => f(composed), x => x);
    const last = funcs[funcs.length - 1];
    const rest = funcs.slice(0, -1);
    return (...args) => rest.reduceRight((composed, f) => f(composed), last(...args));
  }
};

/**
 * Compose the logger with the target, to create a FinalLogger.
 */
export function thenTarget(
  logger: (message: Message) => Message,
  target: (message: Message) => Promise): FinalLogger {
  return msg => target(logger(msg));
};

/**
 * Compose the logger with the Logary state, to build a FinalLogger
 * with the middleware available in Logary.
 */
export function build(
  logary: Logary,
  logger: (m: Message) => Message): FinalLogger {
  return thenTarget(logger, logary.target);
};

export function getLogger(logary: Logary, subSection: string): Logger {
  const logger = message => merge({
    context: {
      service: logary.service,
      logger: subSection
    },
    name: (logary.service + '.' + subSection).split('.')
  }, message);

  //console.log('getLogger middleware', logary.middleware);
  return compose(...logary.middleware)(logger);
};

function traverse(o, state, func) {
  //console.log('traverse on object', JSON.stringify(o), 'state', JSON.stringify(state));
  return Object.keys(o).
    sort().
    reduce((currState, key) => {
      if (o[key] !== null && typeof o[key] === "object") {
        return traverse(o[key], currState, func);
      } else {
        return func.apply(this, [currState, key, o[key]]);
      }
    }, state);
}

/// You need to configure your onerror handler with a logger to send things to.
export function onerror(logger: FinalLogger) {
  return function(msg, file, line, col, error) {
    return logger(Message.eventError('Window onerror', error));
  };
};

type RequestContent =
  { data: Uint8Array|string
  ; contentType: string
  ; contentEncoding: string }

export const Compression = {
  prepareForHttp(data: string|Array|Uint8Array): RequestContent {
    if (Array.isArray(data) && typeof Uint8Array !== 'undefined') {
      return {
        contentType: 'application/octet-stream',
        contentEncoding: 'compress',
        data: Uint8Array.from(data)
      };
    } else if (Object.prototype.toString.call(data) === '[object Uint8Array]') {
      return {
        contentType: 'application/octet-stream',
        contentEncoding: 'compress',
        data
      };
    } else {
      return {
        contentType: 'application/json; charset=utf-8',
        contentEncoding: 'identity',
        data
      };
    }
  },

  /*
     Copyright (c) 2011 Sebastien P.
     http://twitter.com/_sebastienp
     MIT licensed.
     ---
     LZW compression/decompression attempt for 140byt.es.
     Thanks to @bytespider for the 5 bytes shorter compression tip !
     ---
     See http://rosettacode.org/wiki/LZW_compression#JavaScript ...
         https://jsfiddle.net/sebastienp/p7kDe/
  */
  LZW: {
    compress(
      a: string, // String to compress
      b, // Placeholder for dictionary
      c, // Placeholder for dictionary size
      d, // Placeholder for iterator
      e, // Placeholder for w
      f, // Placeholder for result
      g, // Placeholder for c
      h  // Placeholder for wc
    ): Array {
      for (b = {}, c = d = 256; d--;)
        b[String.fromCharCode(d)] = d;

      for (e = f = []; g = a[++d];)
        e = b[h = e + g] ? h : (f.push(b[e]), b[h] = c++, g);

      f.push(b[e]);
      return f;
    },

    decompress(
      a: Array, // Array to decompress
      b, // Placeholder for dictionary
      c, // Placeholder for dictionary size
      d, // Placeholder for iterator
      e, // Placeholder for w
      f, // Placeholder for result
      g, // Placeholder for entry
      h  // Placeholder for k
    ): string {
      for (b = [], c = d = 256, e = String.fromCharCode; d--;)
        b[d] = e(d);

      for (e = f = e(a[d = 0]); (h = a[++d]) <= c;) {
        g = b[h] || e + e[0];
        b[c++] = e + g[0];
        f += e = g;
      }

      return f;
    }
  }
};

type Header =
  { name: string
  ; values: Array<string> }

type Request =
  { content: RequestContent
  ; uri: string
  ; method: string
  ; batchable: boolean
  ; headers: Array<Header> }

export function createRequest(
  method: string,
  uri: string,
  content: RequestContent): Request {

  return {
    content: content,
    batchable: true,
    headers: [
      { name: 'Accept', values: ['application/json'] }
    ],
    uri,
    method
  }
};

export function createContent(data) {
  return Compression.prepareForHttp(JSON.stringify(data));
}

export function ajax(r: Request): Promise {
  const req = new XMLHttpRequest();

  const promise = new Promise(function(resolve, reject) {
    req.addEventListener("load", function() {
      // this.response
      // => JSON
      resolve(this);
    });
    req.addEventListener('error', function() {
      reject(this);
    });
  });

  req.open(r.method, r.uri);
  r.headers.forEach(header =>
    req.setRequestHeader(header.name, header.values.join(',')));
  req.setRequestHeader('content-type', r.content.contentType);
  req.setRequestHeader('content-encoding', r.content.contentEncoding);
  req.send(r.content.data);
}

type LogaryServiceConf =
  { path: string
  ; serialise: (m: Message) => RequestContent
  ; alterRequest: ?(r: Request) => Request
  ; send: ?(r: Request) => Promise }

export const Targets = {
  logaryService(conf: LogaryServiceConf): Function {
    return msg => {
      const content = conf.serialise(msg),
            interm = createRequest(conf.method || 'POST', conf.path, content),
            request = (conf.alterRequest || (x => x))(interm),
            send    = (conf.send || ajax);

      return send(request);
    };
  }
};
