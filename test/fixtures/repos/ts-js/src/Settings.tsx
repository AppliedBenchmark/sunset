export function Settings({ onSave }: { onSave: () => void }) {
  return (
    <form onSubmit={onSave}>
      <label>Model</label><select defaultValue="gpt-fixture-retired" />
      <Icon size={16}/><Badge model="claude-fixture-opus-9" />
    </form>
  );
}
