import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createTransport } from "./network";
import { createBrowserAccess } from './browser';
import {
  type Storage,
} from "./controller";
let webSecret: string | null = null;
export const allowDevWeb = Platform.OS === "web" && __DEV__;
const cache = {
  read: (key: string) => AsyncStorage.getItem(key),
  write: (key: string, value: string) => AsyncStorage.setItem(key, value),
  remove: (key: string) => AsyncStorage.removeItem(key),
};
export const browserAccess = Platform.OS === 'web' && typeof location !== 'undefined' && location.protocol === 'https:'
  ? createBrowserAccess(cache, location.origin)
  : null;
export const storage: Storage = {
  readSecret: () =>
    browserAccess ? browserAccess.readSecret() : Platform.OS === "web"
      ? Promise.resolve(webSecret)
      : SecureStore.getItemAsync("mino-device-v1"),
  writeSecret: async (value) => {
    if (browserAccess) await browserAccess.writeSecret(value);
    else if (Platform.OS === "web") webSecret = value;
    else if (value === null)
      await SecureStore.deleteItemAsync("mino-device-v1");
    else await SecureStore.setItemAsync("mino-device-v1", value);
  },
  ...cache,
};
export const transport = createTransport(allowDevWeb);
