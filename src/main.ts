import { Game } from "./game/game.js";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const game = new Game(canvas);
game.boot();
