module.exports = {
  mount: {
    public: '/',
    src: '/_dist_',
  },
  plugins: ['@snowpack/plugin-sass', ['@snowpack/plugin-optimize']],
};
