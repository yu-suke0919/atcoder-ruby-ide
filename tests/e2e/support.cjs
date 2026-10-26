module.exports = process.platform === 'win32' ? require('./native.cjs') : require('./browser.cjs');
