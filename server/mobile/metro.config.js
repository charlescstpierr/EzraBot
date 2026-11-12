const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    context.originModulePath.includes("/src/generated/") &&
    ["./protocol.js", "./constants.js"].includes(moduleName)
  ) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
