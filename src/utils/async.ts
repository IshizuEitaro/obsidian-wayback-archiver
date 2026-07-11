export const runAsyncAction = (
	action: () => void | Promise<void>,
	onError: (error: unknown) => void,
	onFinally?: () => void,
): void => {
	let result: void | Promise<void>;
	try {
		result = action();
	} catch (error: unknown) {
		onError(error);
		onFinally?.();
		return;
	}
	void Promise.resolve(result).catch(onError).finally(onFinally);
};
