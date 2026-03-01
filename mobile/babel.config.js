module.exports = function (api) {
  api.cache(true);
  let expoPreset;
  try {
    expoPreset = require.resolve("babel-preset-expo");
  } catch {
    expoPreset = require.resolve("expo/node_modules/babel-preset-expo");
  }
  return {
    presets: [expoPreset]
  };
};
