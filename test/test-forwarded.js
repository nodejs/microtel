'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { parseForwarded } = require('../lib/forwarded');

describe('Forwarded header parser', () => {
  // Each case is a header value and the elements it must yield, or null
  // when the value is malformed.
  const cases = [
    ['for=192.0.2.60', [{ for: '192.0.2.60' }]],
    // An element carries any number of parameters in any order.
    [
      'for=192.0.2.60;proto=http;by=203.0.113.43',
      [{ for: '192.0.2.60', proto: 'http', by: '203.0.113.43' }],
    ],
    [
      'for=192.0.2.60,for=198.51.100.17',
      [{ for: '192.0.2.60' }, { for: '198.51.100.17' }],
    ],
    // Parameter names are case-insensitive, values keep their case.
    [
      'FOR=192.0.2.60;Host=Example.COM',
      [{ for: '192.0.2.60', host: 'Example.COM' }],
    ],
    // Values with delimiters in them, IPv6 among them, must be quoted.
    ['for="[2001:db8::1]:4711"', [{ for: '[2001:db8::1]:4711' }]],
    [
      'host="example.com:8080";proto=http',
      [{ host: 'example.com:8080', proto: 'http' }],
    ],
    ['host="[2001:db8::1]:8080"', [{ host: '[2001:db8::1]:8080' }]],
    // A quoted value keeps its spaces, may be empty, and may escape a
    // character by dropping its backslash.
    ['for="  spaced  "', [{ for: '  spaced  ' }]],
    ['host=""', [{ host: '' }]],
    ['for="say \\"hi\\""', [{ for: 'say "hi"' }]],
    ['for="a;b,c"', [{ for: 'a;b,c' }]],
    // An unquoted value ends at whitespace, which is not part of it.
    ['for=1.2.3.4 ; host=a', [{ for: '1.2.3.4', host: 'a' }]],
    // Malformed values yield null: a missing equals sign or value, an
    // unterminated quote, a trailing separator, a token after a closed
    // value, or a delimiter an unquoted value cannot carry, like the
    // colon of a port.
    ['for', null],
    ['for=', null],
    // An unquoted value cannot be empty the way a quoted one can.
    ['for=;host=a', null],
    ['for= ;host=a', null],
    ['for=\t;host=a', null],
    ['for=  ,b=1', null],
    ['for="unterminated', null],
    ['for=1.2.3.4,', null],
    ['for=1.2.3.4;host', null],
    ['for=1.2.3.4 host=a', null],
    ['host=example.com:8080', null],
    // The header may not end on whitespace, not even after a quoted
    // value that already closed.
    ['host="a" ', null],
    ['', null],
  ];

  for (const [header, expected] of cases) {
    it(`parses ${JSON.stringify(header)}`, () => {
      assert.deepStrictEqual(parseForwarded(header), expected);
    });
  }
});
