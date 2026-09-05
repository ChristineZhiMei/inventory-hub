import {
  Alert as AntAlert,
  Button as AntButton,
  Card as AntCard,
  Divider,
  Empty,
  Form,
  Input as AntInput,
  Modal,
  Select as AntSelect,
  Segmented as AntSegmented,
  Skeleton as AntSkeleton,
  Tag,
  type ButtonProps as AntButtonProps,
} from "antd";
import { Popup } from "antd-mobile";
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type FocusEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useMediaQuery } from "@/lib/media";
import { useBodyScrollLock } from "@/lib/scrollLock";
import { cn } from "@/lib/utils";

type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?: ButtonVariant;
  size?: "default" | "sm" | "icon";
  loading?: boolean;
}

function assignRef<T>(
  ref: React.ForwardedRef<T>,
  value: T | null,
) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "default",
      size = "default",
      loading,
      children,
      type = "button",
      ...props
    },
    ref,
  ) => {
    const antType: AntButtonProps["type"] =
      variant === "default" || variant === "destructive"
        ? "primary"
        : variant === "ghost"
          ? "text"
          : "default";
    return (
      <AntButton
        ref={(instance) =>
          assignRef(ref, instance instanceof HTMLButtonElement ? instance : null)
        }
        type={antType}
        htmlType={type}
        danger={variant === "destructive"}
        size={size === "sm" ? "small" : "large"}
        loading={loading}
        className={cn(
          "app-button",
          size === "icon" && "app-button--icon",
          variant === "secondary" && "app-button--secondary",
          className,
        )}
        {...props}
      >
        {children}
      </AntButton>
    );
  },
);
Button.displayName = "Button";

export const Input = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> & {
    prefix?: ReactNode;
    suffix?: ReactNode;
  }
>(({ className, ...props }, ref) => (
  <AntInput
    ref={(instance) => assignRef(ref, instance?.input ?? null)}
    size="large"
    className={cn("app-input", className)}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size">
>(({ className, ...props }, ref) => (
  <AntInput.TextArea
    ref={(instance) => assignRef(ref, instance?.resizableTextArea?.textArea ?? null)}
    size="large"
    className={cn("app-textarea", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

type OptionElement = ReactElement<{
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
}>;

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(
  (
    {
      className,
      children,
      value,
      defaultValue,
      onChange,
      onBlur,
      name,
      disabled,
      id,
      "aria-label": ariaLabel,
      "aria-invalid": ariaInvalid,
    },
    ref,
  ) => {
    const generatedId = useId();
    const mobile = useMediaQuery("(max-width: 767px)");
    const [popupOpen, setPopupOpen] = useState(false);
    useBodyScrollLock(mobile && popupOpen);
    const options = Children.toArray(children)
      .filter((child): child is OptionElement => isValidElement(child))
      .map((child) => ({
        value: String(child.props.value ?? ""),
        label: child.props.children,
        disabled: child.props.disabled,
      }));
    const eventTarget = (next: string) => {
      const target = { value: next, name } as HTMLSelectElement;
      return { target, currentTarget: target };
    };
    return (
      <div className={cn("app-select", className)}>
        <AntSelect
          ref={(instance) =>
            assignRef(ref, instance?.nativeElement as HTMLSelectElement | null)
          }
          id={id ?? `select-${generatedId.replaceAll(":", "")}`}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          value={value == null ? undefined : String(value)}
          defaultValue={defaultValue == null ? undefined : String(defaultValue)}
          options={options}
          disabled={disabled}
          size="large"
          virtual={!mobile}
          onOpenChange={setPopupOpen}
          onChange={(next) =>
            onChange?.(
              eventTarget(String(next)) as ChangeEvent<HTMLSelectElement>,
            )
          }
          onBlur={() =>
            onBlur?.(
              eventTarget(String(value ?? "")) as FocusEvent<HTMLSelectElement>,
            )
          }
          popupMatchSelectWidth={false}
        />
        {name && <input type="hidden" name={name} value={value == null ? "" : String(value)} readOnly />}
      </div>
    );
  },
);
Select.displayName = "Select";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("app-label", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const generatedId = useId();
  const childId = isValidElement<{ id?: string }>(children)
    ? children.props.id
    : undefined;
  const controlId =
    htmlFor ?? childId ?? `field-${generatedId.replaceAll(":", "")}`;
  const control =
    isValidElement<{ id?: string }>(children) && childId !== controlId
      ? cloneElement(children, { id: controlId })
      : children;
  return (
    <Form.Item
      className={cn("app-field", className)}
      layout="vertical"
      label={label}
      htmlFor={controlId}
      required={required}
      validateStatus={error ? "error" : undefined}
      help={error}
      extra={hint}
    >
      {control}
    </Form.Item>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <AntCard className={cn("app-card", className)} styles={{ body: { padding: 0 } }} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("app-card__header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("app-card__title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("app-card__description", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("app-card__content", className)} {...props} />;
}

const tagColor: Record<string, string | undefined> = {
  default: "blue",
  secondary: undefined,
  outline: undefined,
  success: "success",
  warning: "warning",
  destructive: "error",
};

export function Badge({
  className,
  variant = "default",
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: keyof typeof tagColor;
}) {
  return (
    <Tag
      color={tagColor[variant]}
      bordered={variant === "outline"}
      className={cn("app-tag", className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function Separator({ className }: { className?: string }) {
  return <Divider className={cn("app-divider", className)} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Empty
      className="app-empty"
      image={<Icon className="app-empty__icon" />}
      description={
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
      }
    >
      {action}
    </Empty>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <AntSkeleton.Node active className={cn("app-skeleton", className)} />;
}

export function Alert({
  title,
  children,
  tone = "info",
  className,
}: {
  title: string;
  children?: ReactNode;
  tone?: "info" | "error" | "warning" | "success";
  className?: string;
}) {
  return (
    <AntAlert
      showIcon
      type={tone}
      message={title}
      description={children}
      className={className}
    />
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const mobile = useMediaQuery("(max-width: 767px)");
  useBodyScrollLock(mobile && open);
  const heading = (
    <div>
      <strong>{title}</strong>
      {description && <p className="app-dialog__description">{description}</p>}
    </div>
  );
  if (mobile) {
    return (
      <Popup
        visible={open}
        onMaskClick={onClose}
        onClose={onClose}
        bodyClassName="app-mobile-dialog"
        bodyStyle={{ maxHeight: "92dvh" }}
      >
        <div className="app-mobile-dialog__header">{heading}</div>
        <div className="app-mobile-dialog__body">{children}</div>
        {footer && <div className="app-mobile-dialog__footer">{footer}</div>}
      </Popup>
    );
  }
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={heading}
      footer={footer}
      width={600}
      centered
      destroyOnHidden
    >
      {children}
    </Modal>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <AntSegmented
      className={className}
      value={value}
      options={options}
      onChange={(next) => onChange(next as T)}
    />
  );
}
