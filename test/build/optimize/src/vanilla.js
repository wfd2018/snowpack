// global CSS
import 'bootstrap/dist/css/bootstrap.min.css';
import './global.css';
import styleURL from './global-2.css';
import('./dynamic-css.css');

// CSS Modules
import {one, two} from './scoped.module.css';
import * as styles from './scoped-scss.module.scss';

console.log(styleURL, one, two, styles.three, styles.four);
