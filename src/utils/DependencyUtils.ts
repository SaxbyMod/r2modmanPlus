export const splitToNameAndVersion = (dependencyString: string): [string, string] => {
    const parts = dependencyString.split('-');

    if (parts.length !== 3) {
        throw new Error(`Invalid dependency string "${dependencyString}"`);
    }

    return [`${parts[0]}-${parts[1]}`, parts[2]];
};
