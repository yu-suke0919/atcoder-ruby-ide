function compareOutput(actual, expected) {
  const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalize(actual) === normalize(expected);
}

module.exports = { compareOutput };
