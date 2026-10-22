import { useLayer } from './useLayer';
/** Dialog focus and Escape share the same stack as menus and the workspace panel. */
export const useFocusScope = useLayer;
