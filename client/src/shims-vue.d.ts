declare module "*.vue" {
  import type { DefineComponent } from "vue";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// The Cast Web Sender SDK bootstraps itself and calls this global once the
// underlying platform API is ready. See services/cast.ts.
interface Window {
  __onGCastApiAvailable?: (isAvailable: boolean) => void;
}
