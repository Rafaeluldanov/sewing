import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card">
      <h1>Заказ не найден</h1>
      <p>Возможно, он был удалён или ссылка устарела.</p>
      <Link className="btn btn-primary" href="/orders">
        ← К списку заказов
      </Link>
    </div>
  );
}
