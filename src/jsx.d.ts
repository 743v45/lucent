/* eslint-disable @typescript-eslint/no-empty-object-type -- 声明合并需空 extends */
import type { JSX as ReactJSX } from 'react';

declare global {
  namespace JSX {
    interface Element extends ReactJSX.Element {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}
