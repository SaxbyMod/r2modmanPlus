import path from "path";

import * as yaml from "yaml";

import FileUtils from "./FileUtils";
import R2Error from "../model/errors/R2Error";
import ExportFormat from "../model/exports/ExportFormat";
import ExportMod from "../model/exports/ExportMod";
import ManifestV2 from "../model/ManifestV2";
import Profile, { ImmutableProfile } from "../model/Profile";
import ThunderstoreCombo from "../model/ThunderstoreCombo";
import VersionNumber from "../model/VersionNumber";
import FsProvider from "../providers/generic/file/FsProvider";
import ZipProvider from "../providers/generic/zip/ZipProvider";
import ProfileInstallerProvider from "../providers/ror2/installing/ProfileInstallerProvider";
import * as PackageDb from '../r2mm/manager/PackageDexieStore';
import ProfileModList from "../r2mm/mods/ProfileModList";

export async function exportModsToCombos(exportMods: ExportMod[], community: string): Promise<ThunderstoreCombo[]> {
    const dependencyStrings = exportMods.map((m) => m.getDependencyString());
    const combos = await PackageDb.getCombosByDependencyStrings(community, dependencyStrings);

    if (combos.length === 0) {
        throw new R2Error(
            'No importable mods found',
            'None of the mods or versions listed in the shared profile are available on Thunderstore.',
            'Make sure the shared profile is meant for the currently selected game.'
        );
    }

    return combos;
}

async function extractImportedProfileConfigs(
    file: string,
    profileName: string,
    progressCallback: (status: string) => void
) {
    const zipEntries = await ZipProvider.instance.getEntries(file);

    for (const [index, entry] of zipEntries.entries()) {
        if (entry.entryName.startsWith('config/') || entry.entryName.startsWith("config\\")) {
            await ZipProvider.instance.extractEntryTo(
                file,
                entry.entryName,
                path.join(
                    Profile.getRootDir(),
                    profileName,
                    'BepInEx'
                )
            );
        } else if (entry.entryName.toLowerCase() !== "export.r2x") {
            await ZipProvider.instance.extractEntryTo(
                file,
                entry.entryName,
                path.join(
                    Profile.getRootDir(),
                    profileName
                )
            )
        }

        const progress = Math.floor((index/zipEntries.length) * 100);
        progressCallback(`Copying configs to profile: ${progress}%`);
    }
}

async function installModsToProfile(
    comboList: ThunderstoreCombo[],
    modList: ExportMod[],
    profile: ImmutableProfile,
    progressCallback: (status: string) => void
) {
    const disabledMods = modList.filter((m) => !m.isEnabled()).map((m) => m.getName());

    for (const [index, comboMod] of comboList.entries()) {
        const manifestMod: ManifestV2 = new ManifestV2().fromThunderstoreMod(comboMod.getMod(), comboMod.getVersion());

        const installError: R2Error | null = await ProfileInstallerProvider.instance.installMod(manifestMod, profile);
        if (installError instanceof R2Error) {
            throw installError;
        }

        const newModList: ManifestV2[] | R2Error = await ProfileModList.addMod(manifestMod, profile);
        if (newModList instanceof R2Error) {
            throw newModList;
        }

        if (disabledMods.includes(manifestMod.getName())) {
            await ProfileModList.updateMod(manifestMod, profile, async (modToDisable: ManifestV2) => {
                // Need to enable temporarily so the manager doesn't think it's re-disabling a disabled mod.
                modToDisable.enable();
                await ProfileInstallerProvider.instance.disableMod(modToDisable, profile);
                modToDisable.disable();
            });
        }

        const progress = Math.floor((index/comboList.length) * 100);
        progressCallback(`Copying mods to profile: ${progress}%`);
    }
}

export async function parseYamlToExportFormat(yamlContent: string) {
    const parsedYaml = await yaml.parse(yamlContent);
    return new ExportFormat(
        parsedYaml.profileName,
        parsedYaml.mods.map((mod: any) => {
            const enabled = mod.enabled === undefined || mod.enabled;
            return new ExportMod(
                mod.name,
                new VersionNumber(
                    `${mod.version.major}.${mod.version.minor}.${mod.version.patch}`
                ),
                enabled
            );
        })
    );
}

/**
 * Copies mods (which should exists in the cache at this point) to profile folder and
 * updates the profile status. Extracts the configs etc. files that are included in
 * the zip file created when the profile was exported.
 *
 * When updating an existing profile, all this is done to a temporary profile first,
 * and the target profile is overwritten only if the process is successful.
 */
export async function populateImportedProfile(
    comboList: ThunderstoreCombo[],
    exportModList: ExportMod[],
    profileName: string,
    isUpdate: boolean,
    zipPath: string,
    progressCallback: (status: string) => void
) {
    const profile = new ImmutableProfile(isUpdate ? '_profile_update' : profileName);

    if (isUpdate) {
        progressCallback('Cleaning up...');
        await FileUtils.recursiveRemoveDirectoryIfExists(profile.getProfilePath());
    }

    await installModsToProfile(comboList, exportModList, profile, progressCallback);
    await extractImportedProfileConfigs(zipPath, profile.getProfileName(), progressCallback);

    if (isUpdate) {
        progressCallback('Applying changes to updated profile...');
        const targetProfile = new ImmutableProfile(profileName);
        await FileUtils.recursiveRemoveDirectoryIfExists(targetProfile.getProfilePath());
        await FsProvider.instance.rename(profile.getProfilePath(), targetProfile.getProfilePath());
    }
}

//TODO: Check if instead of returning null/empty strings, there's some errors that should be handled
export async function readProfileFile(file: string) {
    let read = '';
    if (file.endsWith('.r2x')) {
        read = (await FsProvider.instance.readFile(file)).toString();
    } else if (file.endsWith('.r2z')) {
        const result: Buffer | null = await ZipProvider.instance.readFile(file, "export.r2x");
        if (result === null) {
            return null;
        }
        read = result.toString();
    }
    return read;
}
