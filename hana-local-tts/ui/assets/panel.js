import { hana } from './sdk.js';

await hana.ready();
document.getElementById('startup-status').textContent = '助手消息下方有「朗读」。第一次要在设置里允许启动进程，然后重新加载这个 App。';
