/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    cmsRender?: import("./lib/cms-render-context").CmsRenderContext;
    readerTextSizeDisabled?: boolean;
  }
}

declare module "*.csv?raw" {
  const content: string;
  export default content;
}
