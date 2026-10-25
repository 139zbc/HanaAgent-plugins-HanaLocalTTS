import { hana } from './sdk.js';

await hana.ready();
document.getElementById('startup-status').textContent = '骨架已加载。朗读按钮下一步再做。';
