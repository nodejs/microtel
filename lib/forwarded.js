'use strict';

// Forwarded header (RFC 7239) parsing. The header is a comma-separated
// list of elements, each a semicolon-separated list of name=value
// parameters, where a value is a token or a quoted string with backslash
// escapes. Parameter names are case-insensitive and lowercased, and values
// keep their case. A malformed header yields null, so a caller treats
// garbage as absent rather than guessing at it.

// RFC 7230 section 3.2.6 token characters, the alphabet parameter names
// and unquoted values are built from.
function isTokenChar(code) {
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x27) ||
    code === 0x2a ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e ||
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x5e && code <= 0x7a) ||
    code === 0x7c ||
    code === 0x7e
  );
}

function isSpace(code) {
  return code === 0x20 || code === 0x09;
}

function isPrint(code) {
  return code >= 0x20 && code <= 0x7e;
}

function isExtended(code) {
  return code >= 0x80 && code <= 0xff;
}

// The characters a backslash escape may produce. A backslash before any
// other control character is malformed, and only a quoted value can carry
// escapes at all, so the backslashes are dropped as the value is built.
function isEscapable(code) {
  return code === 0x09 || isPrint(code) || isExtended(code);
}

// Everything a quoted string may contain without an escape. Whitespace is
// part of the value. Anything else is a control character.
function isQuotedChar(code) {
  return isSpace(code) || isPrint(code) || isExtended(code);
}

const kElementSeparator = 0x2c; // ,
const kParameterSeparator = 0x3b; // ;
const kEquals = 0x3d; // =
const kQuote = 0x22; // "
const kBackslash = 0x5c; // \

// Reads a parameter name and its equals sign. Returns the lowercased name
// and the index after the equals sign, or null. Whitespace separates the
// parameters of an element, so it is skipped before a name everywhere but
// at the very start of the header, where the grammar does not allow it.
function parseName(header, i) {
  if (i !== 0) {
    while (i < header.length && isSpace(header.charCodeAt(i))) i++;
  }
  let start = -1;
  for (; i < header.length; i++) {
    const code = header.charCodeAt(i);
    if (isTokenChar(code)) {
      if (start === -1) start = i;
    } else if (code === kEquals && start !== -1) {
      return { name: header.slice(start, i).toLowerCase(), i: i + 1 };
    } else {
      return null;
    }
  }
  return null;
}

// Reads an unquoted value. It ends at a separator, whose index is
// returned with the value, or at the end of the header, where the index
// is the header's length. Whitespace after the value is not part of it,
// and it must lead to a separator: the header may not end on whitespace.
function parseTokenValue(header, i) {
  const start = i;
  for (; i < header.length; i++) {
    const code = header.charCodeAt(i);
    if (isTokenChar(code)) continue;
    if (code === kParameterSeparator || code === kElementSeparator) break;
    if (isSpace(code)) {
      const end = i;
      // An unquoted value cannot be empty, but a quoted one can.
      if (end === start) return null;
      const next = skipSpace(header, i);
      if (next === header.length) return null;
      const after = header.charCodeAt(next);
      if (after !== kParameterSeparator && after !== kElementSeparator)
        return null;
      return { value: header.slice(start, end), next };
    }
    return null;
  }
  // An unquoted value cannot be empty; only a quoted one can.
  return i === start ? null : { value: header.slice(start, i), next: i };
}

// Reads a quoted value. Escapes are resolved as they are read, so the
// value needs no second pass.
function parseQuotedValue(header, i) {
  let value = '';
  let escaped = false;
  for (; i < header.length; i++) {
    const code = header.charCodeAt(i);
    if (escaped) {
      if (!isEscapable(code)) return null;
      value += header[i];
      escaped = false;
    } else if (code === kBackslash) {
      escaped = true;
    } else if (code === kQuote) {
      const close = i + 1;
      // A value may end the header, but it may not leave trailing
      // whitespace behind.
      if (close === header.length) return { value, next: close };
      const next = skipSpace(header, close);
      if (next === header.length) return null;
      const after = header.charCodeAt(next);
      if (after !== kParameterSeparator && after !== kElementSeparator)
        return null;
      return { value, next };
    } else if (isQuotedChar(code)) {
      value += header[i];
    } else {
      return null;
    }
  }
  // The quote never closed.
  return null;
}

function parseValue(header, i) {
  if (i === header.length) return null;
  return header.charCodeAt(i) === kQuote
    ? parseQuotedValue(header, i + 1)
    : parseTokenValue(header, i);
}

function skipSpace(header, i) {
  while (i < header.length && isSpace(header.charCodeAt(i))) i++;
  return i;
}

// The last header and its elements are kept, malformed or not. A proxy
// chain's header repeats while the same client keeps requesting, and a
// different one simply replaces them.
let lastHeader;
let lastElements;

function parseForwarded(header) {
  if (header === lastHeader) return lastElements;
  lastHeader = header;
  lastElements = parseHeader(header);
  return lastElements;
}

function parseHeader(header) {
  const elements = [];
  let element = {};
  let i = 0;

  for (;;) {
    const name = parseName(header, i);
    if (name === null) return null;
    const value = parseValue(header, name.i);
    if (value === null) return null;
    element[name.name] = value.value;

    // A value that ends at the end of the header ends the header.
    if (value.next === header.length) {
      elements.push(element);
      return elements;
    }

    i = value.next + 1;
    if (header.charCodeAt(value.next) === kElementSeparator) {
      elements.push(element);
      element = {};
    }
  }
}

module.exports = {
  parseForwarded,
};
