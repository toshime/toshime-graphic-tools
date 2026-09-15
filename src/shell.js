// ページの骨組みまわり。いまのところ仕事はひとつだけ。
//
// 見出しの帯（名前とツールタブ）は上端に貼りついたままにしてある。その下に
// プレビューも貼りつくので、帯の高さを --header-h に書き出して CSS から
// 参照できるようにする。帯は折り返しでも高さが変わるので、測り直しは
// ResizeObserver に任せる。

const header = document.querySelector('.app-header');

if (header) {
  const publish = () => {
    const h = Math.round(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--header-h', `${h}px`);
  };
  new ResizeObserver(publish).observe(header);
  publish();
}
