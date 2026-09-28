/**
 * source: juicebox-web js/encodeContactMapDatasourceConfig.js
 *         juicebox-web js/fourdnContactMapDatasourceConfig.js
 *         (aidenlab/juicebox-web master @ 974443b)
 *
 * Copied, not imported, so chat search and the juicebox-web catalog modals read
 * the same igv-data TSVs with the same columns (design §6, §11 Q2). Keep these
 * two objects identical to juicebox-web; server-only fields live in
 * dataSourceConfigs.js.
 */

const encodeContactMapDatasourceConfiguration =
    {
        url: 'https://raw.githubusercontent.com/igvteam/igv-data/main/data/encode/hic.txt',
        columns:
            [
                // 'HREF',
                'Assembly',
                'Biosample',
                'Description',
                'BioRep',
                'TechRep',
                'Lab',
                'Accession',
                'Experiment',
                // 'nvi'
            ],
    }

const fourdnContactMapDatasourceConfiguration =
    {
            url: 'https://raw.githubusercontent.com/igvteam/igv-data/main/data/4dn/4dn_hic.txt',
            columns:
                [
                        // 'url',
                        'Project',
                        'Assembly',
                        'Biosource',
                        'Assay',
                        'Dataset',
                        // 'Description',
                        'Publications',
                        'Lab',
                        'Replicate',
                        'Accession',
                        'Experiment'
                ],
    }

export { encodeContactMapDatasourceConfiguration, fourdnContactMapDatasourceConfiguration }
