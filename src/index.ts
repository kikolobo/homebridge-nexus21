import type { API } from 'homebridge';
import { Nexus21Platform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, Nexus21Platform);
};
