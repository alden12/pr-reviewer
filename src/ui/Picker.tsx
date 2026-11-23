/** A link to each review by name: the build's list, and the home page's "every review here". */
export function ReviewLinks({ names }: { names: string[] }) {
  return (
    <ul>
      {names.map((name) => (
        <li key={name}>
          <a href={`?review=${encodeURIComponent(name)}`}>{name}</a>
        </li>
      ))}
    </ul>
  );
}

/** The list of reviews, when more than one is bundled and the URL names none. */
export function Picker({ names }: { names: string[] }) {
  return (
    <main className="picker">
      <h1>Reviews</h1>
      <ReviewLinks names={names} />
    </main>
  );
}
