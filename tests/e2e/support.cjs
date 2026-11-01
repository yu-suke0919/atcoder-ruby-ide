const runner = process.env.E2E_RUNNER || (process.platform === 'win32' ? 'native' : 'browser');
if (!['browser', 'native'].includes(runner)) throw new Error('E2E_RUNNER must be browser or native');
module.exports = { runner, ...require(`./${runner}.cjs`) };
