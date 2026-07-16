import './styles.css';
import { Game } from './game/Game';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app');

const game = new Game(root);
game.boot().catch((error) => {
  console.error(error);
  root.innerHTML = `<div class="fatal"><strong>渲染器启动失败</strong><span>${String(error)}</span></div>`;
});
