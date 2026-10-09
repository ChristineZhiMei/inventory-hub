import { Select, type SelectProps } from "antd";

/** Keep the native search input editable so a phone tap can open its keyboard. */
export function TaxonomySelect(props: SelectProps<string[]>) {
  return <div className="taxonomy-select">
    <Select
      {...props}
      showSearch={props.showSearch ?? true}
      onOpenChange={(open) => {
        if (!open) props.onSearch?.("");
        props.onOpenChange?.(open);
      }}
    />
  </div>;
}
