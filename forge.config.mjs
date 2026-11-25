import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { join } from 'node:path';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };

export default {
  packagerConfig: {
    asar: { unpackDir: join('node_modules', '@napi-rs') },
    download: { cacheRoot: process.env.electron_config_cache, checksums: electronChecksums },
    ignore: /^\/(?:\.(?:cache|claude)|demo|docs|out|src|tests|AGENTS\.local\.md|sites\.json|tsconfig(?:\.main)?\.json|vite\.config\.ts)(?:\/|$)/,
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['win32', 'darwin'])],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
